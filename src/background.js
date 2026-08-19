const ARMED_KEY = 'armedTabs';
const SECONDS_KEY = 'seconds';
const MODE_KEY = 'mode';
const DEFAULT_MODE = 'media';
const DEFAULT_SECONDS = 10;
const MIN_SECONDS = 1;
const MAX_SECONDS = 3600;

const COLOR_TIMER = '#16a34a';
const COLOR_CLIP = '#eab308';
const COLOR_OFF = '#dc2626';

// Rendering a per-second countdown needs a 1 Hz ticker, and only the background
// can call browser.action. The content script owns the real timer and publishes
// its next-fire deadline; everything here just renders against that deadline.
let ticker = null;
let cache = null;

function clampSeconds(value) {
  if (value === '' || value == null) return DEFAULT_SECONDS;
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return DEFAULT_SECONDS;
  return Math.min(MAX_SECONDS, Math.max(MIN_SECONDS, n));
}

async function getSeconds() {
  const stored = await browser.storage.local.get(SECONDS_KEY);
  return clampSeconds(stored[SECONDS_KEY] ?? DEFAULT_SECONDS);
}

async function getMode() {
  const stored = await browser.storage.local.get(MODE_KEY);
  const mode = stored[MODE_KEY];
  return mode === 'media' || mode === 'timer' ? mode : DEFAULT_MODE;
}

// Armed state is mirrored into storage.session because an MV3 event page can be
// unloaded at any time; timers do not hold it open. `cache` is the hot copy the
// ticker reads so it is not doing async storage reads every second.
async function loadArmed() {
  if (cache) return cache;
  const stored = await browser.storage.session.get(ARMED_KEY);
  cache = stored[ARMED_KEY] ?? {};
  return cache;
}

async function saveArmed(armed) {
  cache = armed;
  await browser.storage.session.set({ [ARMED_KEY]: armed });
}

async function isArmed(tabId) {
  const armed = await loadArmed();
  return Object.prototype.hasOwnProperty.call(armed, tabId);
}

// Clip mode has no countdown while it waits for something measurable to appear,
// so it shows an ellipsis rather than a number.
function formatRemaining(msRemaining) {
  if (msRemaining == null) return '…';
  const remaining = Math.max(0, Math.ceil(msRemaining / 1000));
  // The badge realistically fits about four characters, so long intervals
  // collapse to whole minutes rather than overflowing.
  return remaining < 100 ? String(remaining) : `${Math.ceil(remaining / 60)}m`;
}

function paintArmed(tabId, text, mode) {
  browser.action.setBadgeBackgroundColor({
    color: mode === 'media' ? COLOR_CLIP : COLOR_TIMER,
    tabId
  });
  // Yellow needs dark text to stay legible; green and red need white.
  browser.action.setBadgeTextColor({
    color: mode === 'media' ? '#1f2328' : '#ffffff',
    tabId
  });
  browser.action.setBadgeText({ text, tabId });
}

function showStoppedBadge(tabId) {
  browser.action.setBadgeBackgroundColor({ color: COLOR_OFF, tabId });
  browser.action.setBadgeTextColor({ color: '#ffffff', tabId });
  browser.action.setBadgeText({ text: '–', tabId });
}

// Drops the per-tab override so the tab falls back to the global red "off".
function clearBadge(tabId) {
  browser.action.setBadgeText({ text: null, tabId });
  browser.action.setBadgeBackgroundColor({ color: null, tabId });
  browser.action.setBadgeTextColor({ color: null, tabId });
}

// Global default: any tab with no override reads as not running.
browser.action.setBadgeBackgroundColor({ color: COLOR_OFF });
browser.action.setBadgeTextColor({ color: '#ffffff' });
browser.action.setBadgeText({ text: 'off' });

function paintAll() {
  const armed = cache ?? {};
  const now = Date.now();
  for (const [tabId, entry] of Object.entries(armed)) {
    const remaining = entry.nextTickAt == null ? null : entry.nextTickAt - now;
    paintArmed(Number(tabId), formatRemaining(remaining), entry.mode);
  }
}

function syncTicker() {
  const active = Object.keys(cache ?? {}).length > 0;
  if (active && ticker == null) {
    ticker = setInterval(paintAll, 1000);
  } else if (!active && ticker != null) {
    clearInterval(ticker);
    ticker = null;
  }
}

async function arm(tabId, seconds) {
  try {
    await browser.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  } catch (e) {
    return { armed: false, error: "Can't run on this page." };
  }

  const mode = await getMode();
  let response;
  try {
    response = await browser.tabs.sendMessage(tabId, { type: 'arm', seconds, mode });
  } catch (e) {
    return { armed: false, error: 'Page did not respond. Try reloading it.' };
  }

  const armed = await loadArmed();
  armed[tabId] = {
    seconds,
    mode,
    nextTickAt: response?.nextTickAt ?? null,
    detected: response?.detected ?? null
  };
  await saveArmed(armed);
  syncTicker();
  paintAll();
  return { armed: true, seconds, detected: response?.detected ?? null };
}

async function forget(tabId) {
  const armed = await loadArmed();
  delete armed[tabId];
  await saveArmed(armed);
  syncTicker();
}

async function disarm(tabId) {
  await forget(tabId);
  clearBadge(tabId);
  try {
    await browser.tabs.sendMessage(tabId, { type: 'disarm' });
  } catch (e) {
    // Content script is gone (navigated or never injected); nothing to stop.
  }
  return { armed: false };
}

async function toggle(tabId) {
  if (await isArmed(tabId)) return disarm(tabId);
  return arm(tabId, await getSeconds());
}

browser.runtime.onMessage.addListener((msg, sender) => {
  // Also the recovery path: if the event page was unloaded, the content script's
  // next reschedule wakes it here and the ticker restarts on its own.
  if (msg.type === 'countdown') {
    const tabId = sender.tab?.id;
    if (tabId == null) return false;
    return (async () => {
      const armed = await loadArmed();
      if (!armed[tabId]) return {};
      armed[tabId].nextTickAt = msg.nextTickAt;
      if (msg.detected != null) armed[tabId].detected = msg.detected;
      if (msg.mode != null) armed[tabId].mode = msg.mode;
      await saveArmed(armed);
      syncTicker();
      paintAll();
      return {};
    })();
  }

  if (msg.type === 'getState') {
    return (async () => {
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      const armedTabs = await loadArmed();
      const entry = tab ? armedTabs[tab.id] : null;
      return {
        tabId: tab?.id ?? null,
        armed: Boolean(entry),
        seconds: await getSeconds(),
        mode: await getMode(),
        detected: entry?.detected ?? null
      };
    })();
  }

  if (msg.type === 'toggle') {
    return (async () => {
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      if (!tab) return { armed: false, error: 'No active tab.' };
      return toggle(tab.id);
    })();
  }

  if (msg.type === 'setSeconds') {
    return (async () => {
      const seconds = clampSeconds(msg.seconds);
      await browser.storage.local.set({ [SECONDS_KEY]: seconds });
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      if (tab && (await isArmed(tab.id))) {
        // Re-arm so the new cadence takes effect without a manual stop/start.
        await arm(tab.id, seconds);
      }
      return { seconds };
    })();
  }

  if (msg.type === 'setMode') {
    return (async () => {
      const mode = msg.mode === 'media' || msg.mode === 'timer' ? msg.mode : DEFAULT_MODE;
      await browser.storage.local.set({ [MODE_KEY]: mode });
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      if (tab && (await isArmed(tab.id))) {
        await arm(tab.id, await getSeconds());
      }
      return { mode };
    })();
  }

  if (msg.type === 'autoStopped') {
    const tabId = sender.tab?.id;
    if (tabId == null) return false;
    return (async () => {
      await forget(tabId);
      showStoppedBadge(tabId);
      return {};
    })();
  }

  return false;
});

browser.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-drip') return;
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (tab) await toggle(tab.id);
});

// A real document load destroys the content script, and activeTab is revoked
// by navigation, so an armed tab cannot survive it. Drop the state rather than
// leaving a badge that lies about a timer that no longer exists. Keyed off
// status alone: changeInfo.url is withheld without the "tabs" permission, and
// in-page SPA navigation never reports a loading status, which is what we want.
browser.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.status !== 'loading') return;
  if (await isArmed(tabId)) {
    await forget(tabId);
    clearBadge(tabId);
  }
});

browser.tabs.onRemoved.addListener((tabId) => forget(tabId));

// Opening a tab means attention left the feed, so every armed tab restarts its
// countdown but stays armed. A new tab that steals focus is already covered by
// the visibility rule; this is what catches a background tab (ctrl-click), where
// the armed tab stays visible and would otherwise keep counting down.
browser.tabs.onCreated.addListener(async (newTab) => {
  const armed = await loadArmed();
  for (const tabId of Object.keys(armed)) {
    const id = Number(tabId);
    if (id === newTab.id) continue;
    const response = await browser.tabs.sendMessage(id, { type: 'reset' }).catch(() => null);
    if (response) armed[id].nextTickAt = response.nextTickAt;
  }
  await saveArmed(armed);
  paintAll();
});
