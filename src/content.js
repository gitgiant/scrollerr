(() => {
  if (window.__dripScrollerInstalled) return;
  window.__dripScrollerInstalled = true;

  const NOTCH_PX = 100;
  const NOTCHES = 3;
  const DELTA_Y = NOTCHES * NOTCH_PX;
  const MAX_DEAD_TICKS = 5;
  const INPUT_DEBOUNCE_MS = 150;
  const MIN_MEDIA_AREA = 10000;
  const MAX_MEDIA_WAIT_MS = 300000;
  const LOOP_WRAP_EPSILON = 0.15;
  const RECHECK_MS = 1000;

  let armed = false;
  let mode = 'media';
  let intervalMs = 10000;
  let armedOrigin = null;
  let timerId = null;
  let debounceId = null;
  let deadTicks = 0;
  let nextTickAt = null;
  let scheduleToken = 0;
  let detachWatch = null;
  let detected = 'idle';

  const gifCache = new Map();

  function report() {
    browser.runtime.sendMessage({ type: 'countdown', nextTickAt, detected, mode }).catch(() => {});
  }

  // Clip mode never falls back to the interval, so when there is nothing
  // measurable in view it re-looks shortly instead of scrolling.
  function recheckSoon(reason) {
    detected = reason;
    nextTickAt = null;
    timerId = setTimeout(schedule, RECHECK_MS);
    report();
  }

  // ---- media discovery ------------------------------------------------------

  function visibleArea(el) {
    const r = el.getBoundingClientRect();
    const w = Math.min(r.right, window.innerWidth) - Math.max(r.left, 0);
    const h = Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0);
    return w > 0 && h > 0 ? w * h : 0;
  }

  function collectDeep(root, selector, out, budget) {
    for (const el of root.querySelectorAll(selector)) out.push(el);
    if (budget.n <= 0) return;
    for (const el of root.querySelectorAll('*')) {
      if (budget.n-- <= 0) return;
      if (el.shadowRoot) collectDeep(el.shadowRoot, selector, out, budget);
    }
  }

  function largestVisible(elements) {
    let best = null;
    let bestArea = MIN_MEDIA_AREA;
    for (const el of elements) {
      const area = visibleArea(el);
      if (area > bestArea) {
        best = el;
        bestArea = area;
      }
    }
    return best;
  }

  // Videos are searched separately from images, and first. Feeds overlay a
  // poster <img> on the clip at identical dimensions, so a combined
  // largest-by-area search picks the poster and never sees the video.
  function findVideo() {
    let video = largestVisible(document.querySelectorAll('video'));
    if (video) return video;
    // Only pay for a shadow-DOM walk when the light DOM had nothing.
    const deep = [];
    collectDeep(document, 'video', deep, { n: 4000 });
    return largestVisible(deep);
  }

  function findGif() {
    const gifs = [];
    for (const img of document.querySelectorAll('img')) {
      const src = img.currentSrc || img.src || '';
      if (/\.gif(\?|#|$)/i.test(src)) gifs.push(img);
    }
    return largestVisible(gifs);
  }

  // ---- GIF duration ---------------------------------------------------------

  // Walks the GIF block structure summing per-frame delays. This exists because
  // nothing in the DOM exposes a GIF's length or playback position.
  function parseGifDurationMs(buffer) {
    const b = new Uint8Array(buffer);
    const view = new DataView(buffer);
    if (b[0] !== 0x47 || b[1] !== 0x49 || b[2] !== 0x46) return null;

    let p = 6;
    const packed = b[p + 4];
    p += 7;
    if (packed & 0x80) p += (2 << (packed & 7)) * 3;

    const skipSubBlocks = () => {
      while (p < b.length && b[p] !== 0) p += b[p] + 1;
      p += 1;
    };

    let total = 0;
    while (p < b.length) {
      const block = b[p];
      if (block === 0x3b) break;

      if (block === 0x21) {
        const label = b[p + 1];
        p += 2;
        if (label === 0xf9) {
          const size = b[p];
          const delay = view.getUint16(p + 2, true);
          // Browsers clamp 0 and 1 hundredths up to 10, matching real playback.
          total += (delay <= 1 ? 10 : delay) * 10;
          p += size + 1;
        }
        skipSubBlocks();
      } else if (block === 0x2c) {
        p += 1;
        const lct = b[p + 8];
        p += 9;
        if (lct & 0x80) p += (2 << (lct & 7)) * 3;
        p += 1;
        skipSubBlocks();
      } else {
        return null;
      }
    }
    return total > 0 ? total : null;
  }

  async function gifDurationMs(src) {
    if (!src) return null;
    if (gifCache.has(src)) return gifCache.get(src);
    let duration = null;
    try {
      // force-cache so this reads the already-downloaded image rather than
      // refetching it. Cross-origin hosts without CORS headers throw here.
      const res = await fetch(src, { cache: 'force-cache' });
      duration = parseGifDurationMs(await res.arrayBuffer());
    } catch (e) {
      duration = null;
    }
    gifCache.set(src, duration);
    return duration;
  }

  // ---- media watching -------------------------------------------------------

  function clearWatch() {
    if (detachWatch) detachWatch();
    detachWatch = null;
  }

  function remainingMs(video) {
    if (!Number.isFinite(video.duration) || video.duration <= 0) return null;
    const rate = video.playbackRate || 1;
    return (Math.max(0, video.duration - video.currentTime) / rate) * 1000;
  }

  // Event-driven rather than one computed setTimeout: feed clips are often MSE
  // streams whose duration only settles after metadata, and looping clips never
  // fire 'ended' at all, so the wrap in currentTime is the real end-of-play signal.
  function watchVideo(video) {
    let last = video.currentTime;
    const token = scheduleToken;

    const fire = () => {
      if (token !== scheduleToken) return;
      clearWatch();
      tick();
    };

    const onTimeUpdate = () => {
      if (video.currentTime + LOOP_WRAP_EPSILON < last) {
        fire();
        return;
      }
      last = video.currentTime;
      const remaining = remainingMs(video);
      if (remaining != null) {
        nextTickAt = Date.now() + remaining;
        report();
      }
    };

    const onMeta = () => {
      last = video.currentTime;
      onTimeUpdate();
    };

    video.addEventListener('ended', fire);
    video.addEventListener('timeupdate', onTimeUpdate);
    video.addEventListener('loadedmetadata', onMeta);

    detachWatch = () => {
      video.removeEventListener('ended', fire);
      video.removeEventListener('timeupdate', onTimeUpdate);
      video.removeEventListener('loadedmetadata', onMeta);
    };

    // Stall guard, not a timer: a clip that buffers forever would otherwise
    // hang the scroller with no way out.
    timerId = setTimeout(fire, MAX_MEDIA_WAIT_MS);

    const remaining = remainingMs(video);
    nextTickAt = remaining == null ? null : Date.now() + remaining;
    detected = Number.isFinite(video.duration)
      ? `video ${video.duration.toFixed(1)}s`
      : 'video (duration pending)';
  }

  // ---- scheduling -----------------------------------------------------------

  async function schedule() {
    clearTimeout(timerId);
    timerId = null;
    clearWatch();
    const token = ++scheduleToken;

    if (!armed || document.hidden) {
      nextTickAt = null;
      detected = armed ? 'paused (tab hidden)' : 'idle';
      report();
      return;
    }

    if (mode === 'media') {
      const video = findVideo();
      if (video) {
        if (video.paused) {
          recheckSoon('clip paused — waiting');
          return;
        }
        watchVideo(video);
        report();
        return;
      }

      const gif = findGif();
      if (!gif) {
        recheckSoon('no clip in view — waiting');
        return;
      }

      const duration = await gifDurationMs(gif.currentSrc || gif.src);
      if (token !== scheduleToken) return;
      if (!duration) {
        recheckSoon('gif unreadable (CORS) — waiting');
        return;
      }

      // A GIF's current frame is not observable, so its phase is unknown;
      // the best available answer is one full loop measured from now.
      const delay = Math.min(duration, MAX_MEDIA_WAIT_MS);
      detected = `gif ${(duration / 1000).toFixed(1)}s`;
      nextTickAt = Date.now() + delay;
      timerId = setTimeout(tick, delay);
      report();
      return;
    }

    detected = 'timer';
    nextTickAt = Date.now() + intervalMs;
    timerId = setTimeout(tick, intervalMs);
    report();
  }

  function stopTimer() {
    clearTimeout(timerId);
    timerId = null;
    clearWatch();
    nextTickAt = null;
    scheduleToken += 1;
    detected = 'idle';
    report();
  }

  // ---- scrolling ------------------------------------------------------------

  // An element only counts as the scroll container if it both declares a
  // scrolling overflow and actually has overflow to scroll.
  function isScrollable(el) {
    if (!(el instanceof Element)) return false;
    const overflowY = getComputedStyle(el).overflowY;
    if (overflowY !== 'auto' && overflowY !== 'scroll' && overflowY !== 'overlay') return false;
    return el.scrollHeight > el.clientHeight + 1;
  }

  function findScrollTarget(x, y) {
    let el = document.elementFromPoint(x, y);
    while (el) {
      if (isScrollable(el)) return el;
      el = el.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  }

  function tick() {
    if (!armed) return;

    if (location.origin !== armedOrigin) {
      selfDisarm('origin');
      return;
    }

    const x = Math.floor(window.innerWidth / 2);
    const y = Math.floor(window.innerHeight / 2);
    const hit = document.elementFromPoint(x, y);
    const target = findScrollTarget(x, y);

    const wheel = new WheelEvent('wheel', {
      deltaX: 0,
      deltaY: DELTA_Y,
      deltaZ: 0,
      deltaMode: WheelEvent.DOM_DELTA_PIXEL,
      clientX: x,
      clientY: y,
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window
    });

    // dispatchEvent returns false when a handler called preventDefault. The
    // event is untrusted so it never triggers native scrolling itself; this
    // mirrors what the browser would have done with a real notch.
    const pageDeclined = !(hit || target).dispatchEvent(wheel);

    if (pageDeclined) {
      // Page owns the scroll. We never reached scrollBy, so scrollTop staying
      // put proves nothing and must not count toward the dead-tick tally.
      schedule();
      return;
    }

    const before = target.scrollTop;
    // 'instant', not 'auto': 'auto' defers to the element's CSS scroll-behavior,
    // and on a site that sets `scroll-behavior: smooth` the scroll would still be
    // animating when we read scrollTop back, making every tick look dead.
    target.scrollBy({ top: DELTA_Y, left: 0, behavior: 'instant' });

    if (Math.abs(target.scrollTop - before) < 1) {
      deadTicks += 1;
      if (deadTicks >= MAX_DEAD_TICKS) {
        selfDisarm('exhausted');
        return;
      }
    } else {
      deadTicks = 0;
    }

    schedule();
  }

  function selfDisarm(reason) {
    armed = false;
    stopTimer();
    browser.runtime.sendMessage({ type: 'autoStopped', reason }).catch(() => {});
  }

  function onUserInput(e) {
    // Our synthetic wheel is untrusted, so this never sees our own events.
    if (!e.isTrusted || !armed) return;
    clearTimeout(debounceId);
    debounceId = setTimeout(schedule, INPUT_DEBOUNCE_MS);
  }

  for (const type of ['wheel', 'keydown', 'touchmove']) {
    window.addEventListener(type, onUserInput, { capture: true, passive: true });
  }

  document.addEventListener('visibilitychange', () => {
    if (!armed) return;
    if (document.hidden) stopTimer();
    else schedule();
  });

  browser.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'arm') {
      armed = true;
      mode = msg.mode === 'media' ? 'media' : 'timer';
      intervalMs = msg.seconds * 1000;
      armedOrigin = location.origin;
      deadTicks = 0;
      return schedule().then(() => ({ armed: true, nextTickAt, detected }));
    }
    if (msg.type === 'reset') {
      // Restart the countdown without disarming. Opening a tab is attention
      // moving away from the feed, same as a manual scroll.
      if (!armed) return Promise.resolve({ armed, nextTickAt, detected });
      return schedule().then(() => ({ armed, nextTickAt, detected }));
    }
    if (msg.type === 'disarm') {
      armed = false;
      stopTimer();
      return Promise.resolve({ armed: false });
    }
    if (msg.type === 'ping') {
      return Promise.resolve({ armed, nextTickAt, detected });
    }
    return false;
  });
})();
