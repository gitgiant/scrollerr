const modeSelect = document.getElementById('mode');
const secondsInput = document.getElementById('seconds');
const secondsLabel = document.getElementById('seconds-label');
const toggleButton = document.getElementById('toggle');
const statusLine = document.getElementById('status');
const detectLine = document.getElementById('detect');
const errorLine = document.getElementById('error');

let poll = null;

function renderMode(mode) {
  modeSelect.value = mode;
  // Clip mode does not fall back to the interval at all, so the timer field is
  // inert and says so rather than sitting there looking like it still applies.
  const clip = mode === 'media';
  secondsInput.disabled = clip;
  secondsLabel.textContent = clip ? 'Timer off —' : 'Every';
  document.getElementById('seconds-field').classList.toggle('disabled', clip);
}

function render(state) {
  toggleButton.textContent = state.armed ? 'Stop' : 'Start';
  toggleButton.classList.toggle('running', state.armed);
  statusLine.textContent = state.armed
    ? 'Running on this tab. Pauses while you scroll.'
    : 'Not running on this tab.';

  // Shows what clip mode actually latched onto, so a silent fall back to the
  // timer is visible rather than looking like clip mode is broken.
  const showDetect = state.armed && state.detected;
  detectLine.hidden = !showDetect;
  if (showDetect) detectLine.textContent = `Watching: ${state.detected}`;
}

function showError(message) {
  errorLine.textContent = message;
  errorLine.hidden = !message;
}

async function refresh() {
  render(await browser.runtime.sendMessage({ type: 'getState' }));
}

async function init() {
  const state = await browser.runtime.sendMessage({ type: 'getState' });
  secondsInput.value = state.seconds;
  renderMode(state.mode);
  render(state);
  poll = setInterval(refresh, 1000);
}

toggleButton.addEventListener('click', async () => {
  showError('');
  const result = await browser.runtime.sendMessage({ type: 'toggle' });
  if (result.error) showError(result.error);
  render(result);
});

secondsInput.addEventListener('change', async () => {
  const result = await browser.runtime.sendMessage({
    type: 'setSeconds',
    seconds: secondsInput.value
  });
  secondsInput.value = result.seconds;
  refresh();
});

modeSelect.addEventListener('change', async () => {
  const result = await browser.runtime.sendMessage({
    type: 'setMode',
    mode: modeSelect.value
  });
  renderMode(result.mode);
  refresh();
});

window.addEventListener('unload', () => clearInterval(poll));

init();
