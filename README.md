#Scrollerr

Firefox extension that scrolls the current tab down by three wheel notches (~300px)
every N seconds. Default 10. Built for slow feed-advance, not for reading along.

## Install (temporary)

```
npm run dev
```

Launches a throwaway Firefox profile (`.dev-profile/`, gitignored) with the extension
loaded and reloads it on every file save. Before launching, `scripts/setup-dev-profile.js`
pre-seeds that profile so private-browsing access is already granted and the toolbar button
is already pinned — see below for what that does and its one caveat.

Or load it into your normal Firefox by hand: go to `about:debugging#/runtime/this-firefox`,
click **Load Temporary Add-on**, pick `src/manifest.json`. `npm run dev`'s automatic pin and
private-browsing grant only apply to the `.dev-profile/` profile — loading it into your own
profile this way still needs both done by hand (see below).

**A temporary add-on is removed when Firefox restarts.** To make it permanent you would
have to sign it — `web-ext sign --channel=unlisted` with AMO API credentials produces a
self-distributed `.xpi` that installs for good. Firefox release and beta ignore
`xpinstall.signatures.required=false`, so unsigned permanent installs only work on
Developer Edition, Nightly, or ESR.

## Private browsing and the toolbar button

Firefox disables extensions in private windows by default, and hides a newly installed
extension's button in the overflow "puzzle piece" menu instead of pinning it — no manifest
key overrides either one. `npm run dev` automates both for `.dev-profile/`:

- **Private windows** is granted unconditionally by writing the permission straight into
  the profile's `extension-preferences.json`, keyed to the extension's fixed id
  (`browser_specific_settings.gecko.id` in `manifest.json`). This takes effect from the
  very first run.
- **Toolbar pin** is done by editing the profile's saved `browser.uiCustomization.state`
  (in `prefs.js`) to move the extension's button into the nav bar. That pref only exists
  once Firefox itself has written it, which happens on exit from a run — so **the very
  first `npm run dev` after deleting `.dev-profile/` starts unpinned; every run after that
  is pinned**, including if you unpin it by hand (the script re-pins on the next `npm run
  dev`).

Loading the extension into your own everyday profile (rather than `.dev-profile/`) still
needs both done by hand: `about:addons` → Drip Scroller → **Allow in Private Windows**, and
dragging the button out of the extensions menu to pin it.

## Use

Click the toolbar button, set the interval, hit **Start**. `Alt+Shift+S` toggles without
opening the popup. The badge counts down the seconds to the next scroll, so you can see the
timer reset whenever you scroll by hand. Intervals of 100s or more show as whole minutes
(`6m`) because the badge only fits about four characters.

Badge colours:

| Colour | Meaning |
| --- | --- |
| Green | Running in timer mode, counting down |
| Yellow | Running in clip mode; `…` means it is waiting for a clip to appear |
| Red `off` | Not running on this tab |
| Red `–` | Stopped itself after five ticks that failed to move the page |
(`Ctrl+Shift+Y` was avoided: it is Firefox's Downloads shortcut on Windows and Linux.)

## Installing on another machine

`npm run build` writes `dist/drip_scroller-1.0.0.zip`. Copy that one file over, then on the
target machine open `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on** and
select the `.zip` directly — no unzipping needed. Same temporary-install caveat applies: it
is gone after a Firefox restart.

## Clip mode

The popup's **Scroll when** selector switches between `timer ends` and `clip ends`.
**`clip ends` (clip mode) is the default** for a fresh install. In clip
mode each scroll waits for the largest piece of media visible in the viewport to finish
playing, and **the timer is fully off** — the seconds field is disabled, and nothing scrolls
on an interval. If no measurable clip is in view it re-looks once a second and waits
indefinitely rather than scrolling. That means clip mode on a page with no video simply
never scrolls, by design; the badge shows yellow `…` while it waits.

How well this works depends entirely on what the "GIF" actually is:

- **`<video>` (what Reddit, X, Imgur, Tenor and Giphy actually serve, in WebM or MP4 —
  the container makes no difference)** — exact, and event-driven. It listens for `ended`,
  and because looping clips never fire `ended`, it also treats a backwards jump in
  `currentTime` as the end of a play. Videos are searched for before images and in open
  shadow roots if the light DOM has none.
- **A real `<img src="…gif">`** — approximate. Nothing in the DOM exposes a GIF's length or
  current frame, so the extension fetches the image bytes and walks the GIF block structure
  itself, summing the per-frame delays in the Graphic Control Extension blocks. That yields
  the loop length, but not the phase — there is no way to know how far into a loop the GIF
  already is, so it waits one full loop starting from now. Expect to catch it mid-loop.
  Parsed durations are cached per URL. If the image is cross-origin and the host sends no
  CORS headers the fetch throws, and that clip falls back to the timer.
- **CSS animations, canvas, WebGL, sprite sheets** — not detectable at all. Timer fallback.

A playing clip that buffers forever is capped at five minutes as a stall guard. A paused
clip is not scrolled past at all — it waits for playback to start.

While clip mode is armed the popup shows a **Watching:** line naming what it latched onto —
`video 6.4s`, `gif 1.9s`, `no clip in view — waiting`, `clip paused — waiting`,
`gif unreadable (CORS) — waiting`. Since clip mode waits silently instead of falling back,
this line is the way to tell waiting apart from broken.

## Behaviour

- **Per tab.** Arming one tab does not touch any other. State is not shared.
- **Real scrolling wins.** Any genuine scroll, keypress, or touch restarts the countdown,
  so the drip only fires after N seconds of you not touching anything.
- **Pauses when hidden.** Switching away stops the timer; switching back restarts the full
  interval. Keeps a backgrounded feed from silently loading content forever.
- **Opening a tab resets it.** Any new tab restarts the countdown on every armed tab
  without disarming them. A new tab that takes focus is already handled by the pause rule;
  this covers ctrl-clicking a post into the background, where the feed stays visible.
- **Stops on a dead page.** Five consecutive ticks that fail to move anything disarm it and
  turn the badge grey. Ticks the page intercepted don't count toward that.
- **Navigation disarms it.** A real page load destroys the content script and revokes
  `activeTab`, so the tab unarms. In-page (SPA) navigation, which is what infinite feeds
  actually do, keeps running. Leaving the origin disarms it too.

## How the scroll works

Firefox extensions cannot synthesize trusted input, so a dispatched `wheel` event has
`isTrusted: false` and never triggers native scrolling on its own. Each tick therefore
does what the browser would have done with a real notch, in two steps: dispatch a
cancelable `wheel` at the viewport centre, then call `scrollBy` **only if** no handler
called `preventDefault`. Sites that hijack scrolling (X, TikTok, smooth-scroll libraries)
take the first path; ordinary pages take the second. Nothing gets scrolled twice.

The scroll container is resolved per tick by walking up from `elementFromPoint` at the
viewport centre to the first ancestor with a scrolling overflow and real overflow to
scroll, falling back to `document.scrollingElement`. Top frame only — iframes are ignored
so an ad frame can't steal the scroll.

## Permissions

`activeTab` (granted per tab only when you click the button or press the shortcut),
`scripting` (to inject the timer), `storage` (to remember the interval). No host
permissions — the extension has no access to any site you haven't explicitly armed.

## Layout

```
src/manifest.json   MV3, event page, activeTab
src/background.js   per-tab armed registry, badge, toolbar/shortcut, navigation cleanup
src/content.js      the timer, wheel dispatch, scroll target, pause/reset rules
src/popup.*         interval input and start/stop
scripts/setup-dev-profile.js   pre-seeds .dev-profile/ before `npm run dev` (see above)
```

The repeating timer lives in the content script, not the background. MV3 event pages
unload when idle and `browser.alarms` is clamped near one-minute granularity, so a
background timer could not do a 10-second drip.

The badge countdown is split across both for the same reason. Only the background can call
`browser.action`, so it runs a 1 Hz repaint — but it does not own a timer. The content
script publishes the wall-clock deadline of its next tick on every reschedule, and the
background renders `deadline - now` against it. If the event page gets unloaded mid-run the
badge simply freezes; the next deadline the content script publishes wakes the page and the
ticker restarts, so scrolling never depends on the badge being alive.
