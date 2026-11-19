// Show/hide toggle for every password field, including ones inside dialogs.
// Fields start hidden; the eye button reveals what was typed and hides it again.
import { icon } from './ui.js';

const ICON_SIZE = 17;
const SHOW = { label: 'Show password', icon: () => icon('eye', ICON_SIZE) };
const HIDE = { label: 'Hide password', icon: () => icon('eyeOff', ICON_SIZE) };

function addToggle(input) {
  if (input.dataset.pwToggle) return;
  input.dataset.pwToggle = '1';
  const wrap = document.createElement('span');
  wrap.className = 'pw-wrap';
  input.replaceWith(wrap);
  wrap.append(input);
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'pw-toggle';
  btn.setAttribute('aria-pressed', 'false');
  btn.setAttribute('aria-label', SHOW.label);
  btn.title = SHOW.label;
  if (input.id) btn.setAttribute('aria-controls', input.id);
  btn.innerHTML = SHOW.icon();
  wrap.append(btn);
}

function setVisible(btn, visible) {
  const input = btn.parentElement.querySelector('input');
  input.type = visible ? 'text' : 'password';
  const state = visible ? HIDE : SHOW;
  btn.setAttribute('aria-pressed', String(visible));
  btn.setAttribute('aria-label', state.label);
  btn.title = state.label;
  btn.innerHTML = state.icon();
}

document.addEventListener('click', (e) => {
  const btn = e.target.closest('.pw-toggle');
  if (!btn) return;
  e.preventDefault();
  const input = btn.parentElement.querySelector('input');
  const caret = [input.selectionStart, input.selectionEnd];
  setVisible(btn, input.type === 'password');
  input.focus();
  try { input.setSelectionRange(...caret); } catch { /* some browsers reject this on type switch */ }
});
// Keep the mouse click on the button from stealing focus from the field first.
document.addEventListener('mousedown', (e) => { if (e.target.closest('.pw-toggle')) e.preventDefault(); });
// Never submit a form with the password left visible on screen.
document.addEventListener('submit', (e) => {
  e.target.querySelectorAll?.('.pw-toggle[aria-pressed="true"]').forEach((btn) => setVisible(btn, false));
}, true);

const scan = (root) => root.querySelectorAll('input[type="password"]:not([data-pw-toggle])').forEach(addToggle);
scan(document);
new MutationObserver(() => scan(document)).observe(document.body, { childList: true, subtree: true });
