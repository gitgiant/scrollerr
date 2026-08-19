#!/usr/bin/env node
// Pre-seeds the throwaway Firefox profile `npm run dev` launches into, so the
// extension doesn't need two manual clicks (about:addons > Allow in Private
// Windows, and pinning the toolbar button) every time the profile is recreated.
//
// - Private Windows access is granted unconditionally: this is our own dev
//   profile, nobody else's browsing data, so there is no permission prompt to
//   respect.
// - The toolbar pin is best-effort. `browser.uiCustomization.state` is an
//   undocumented, Firefox-version-dependent blob, so this only ever *adds*
//   our widget id to an *existing* saved layout (written by a prior run of
//   Firefox against this same profile) rather than fabricating one from
//   scratch. A brand-new profile has no layout yet — Firefox writes its
//   real defaults on exit (`web-ext run` is invoked with
//   --keep-profile-changes), and the next `npm run dev` picks that up and
//   pins into it. So: unpinned on the very first run, pinned from the
//   second run onward. Never touches any area's placements it isn't
//   already the (undamaged) owner of.
//
// Never throws: a failure here must not block `npm run dev` from starting
// Firefox at all, it just means one less convenience got applied.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PROFILE_DIR = path.join(ROOT, '.dev-profile');
const PREFS_PATH = path.join(PROFILE_DIR, 'prefs.js');
const EXT_PREFS_PATH = path.join(PROFILE_DIR, 'extension-preferences.json');

function readManifestId() {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'manifest.json'), 'utf8'));
  const id = manifest.browser_specific_settings?.gecko?.id;
  if (!id) throw new Error('manifest.json has no browser_specific_settings.gecko.id');
  return id;
}

// Matches Firefox's ExtensionCommon.makeWidgetId(): lowercase, then every
// character outside [a-z0-9_-] becomes an underscore.
function widgetIdFor(extensionId) {
  return extensionId.toLowerCase().replace(/[^a-z0-9_-]/g, '_') + '-browser-action';
}

function grantPrivateBrowsing(extensionId) {
  let store = {};
  if (fs.existsSync(EXT_PREFS_PATH)) {
    try {
      store = JSON.parse(fs.readFileSync(EXT_PREFS_PATH, 'utf8'));
    } catch (e) {
      store = {};
    }
  }
  const entry = store[extensionId] ?? { permissions: [], origins: [] };
  if (!entry.permissions.includes('internal:privateBrowsingAllowed')) {
    entry.permissions.push('internal:privateBrowsingAllowed');
  }
  store[extensionId] = entry;
  fs.writeFileSync(EXT_PREFS_PATH, JSON.stringify(store));
}

function pinToToolbar(widgetId) {
  if (!fs.existsSync(PREFS_PATH)) return; // nothing written by Firefox yet

  const raw = fs.readFileSync(PREFS_PATH, 'utf8');
  const match = raw.match(/^user_pref\("browser\.uiCustomization\.state",\s*(".*")\);$/m);
  if (!match) return; // layout not customized/persisted yet

  let state;
  try {
    state = JSON.parse(JSON.parse(match[1]));
  } catch (e) {
    return; // unrecognized shape, don't guess
  }

  state.placements ??= {};
  state.placements['nav-bar'] ??= [];

  // A widget id must not appear in more than one area at once.
  for (const [area, ids] of Object.entries(state.placements)) {
    if (area === 'nav-bar' || !Array.isArray(ids)) continue;
    const i = ids.indexOf(widgetId);
    if (i !== -1) ids.splice(i, 1);
  }

  if (!state.placements['nav-bar'].includes(widgetId)) {
    // Land immediately left of the extensions (puzzle-piece) button, matching
    // where Firefox puts an icon when a person pins it by hand.
    const extBtn = state.placements['nav-bar'].indexOf('unified-extensions-button');
    if (extBtn === -1) state.placements['nav-bar'].push(widgetId);
    else state.placements['nav-bar'].splice(extBtn, 0, widgetId);
  }

  state.seen ??= [];
  if (!state.seen.includes(widgetId)) state.seen.push(widgetId);

  const newLine = `user_pref("browser.uiCustomization.state", ${JSON.stringify(JSON.stringify(state))});`;
  fs.writeFileSync(PREFS_PATH, raw.slice(0, match.index) + newLine + raw.slice(match.index + match[0].length));
}

function main() {
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  const extensionId = readManifestId();
  try {
    grantPrivateBrowsing(extensionId);
  } catch (e) {
    console.warn('[setup-dev-profile] could not grant private browsing access:', e.message);
  }
  try {
    pinToToolbar(widgetIdFor(extensionId));
  } catch (e) {
    console.warn('[setup-dev-profile] could not pin toolbar button:', e.message);
  }
}

main();
