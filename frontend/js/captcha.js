// Cloudflare Turnstile widget for the sign-in and sign-up pages. The server checks the token it produces.
// When the server has no Turnstile keys, nothing is loaded and getCaptchaToken() returns null.
const SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

let scriptLoading = null;
let widgetId = null;
let widgetEl = null;

function loadScript() {
  scriptLoading ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = SCRIPT; s.async = true;
    s.onload = () => resolve(window.turnstile);
    s.onerror = () => { scriptLoading = null; reject(new Error('Could not load the "verify you are human" check. Check your connection and reload.')); };
    document.head.appendChild(s);
  });
  return scriptLoading;
}

/**
 * Draws the widget into `el` (a `.captcha` placeholder).
 * @param {HTMLElement | null} el
 * @param {string | null} siteKey
 */
export async function mountCaptcha(el, siteKey) {
  widgetId = null; widgetEl = el;
  if (!el || !siteKey) return;
  try {
    const ts = await loadScript();
    if (!el.isConnected) return; // the person already left the page
    widgetId = ts.render(el, { sitekey: siteKey, theme: 'auto', 'refresh-expired': 'auto' });
  } catch (e) {
    const note = document.createElement('div');
    note.className = 'notice err'; note.textContent = e.message;
    el.replaceChildren(note);
  }
}

/** The current token, or null when the captcha is off. Throws when the person hasn't passed the check yet. */
export function getCaptchaToken() {
  if (widgetId === null || !window.turnstile || !widgetEl?.isConnected) return null; // no widget on this page
  const token = window.turnstile.getResponse(widgetId);
  if (!token) throw new Error('Wait for the "verify you are human" check to finish (or tick it), then try again.');
  return token;
}

/** Tokens are single-use: get a fresh one after every attempt. */
export function resetCaptcha() {
  if (widgetId !== null && window.turnstile && widgetEl?.isConnected) window.turnstile.reset(widgetId);
}
