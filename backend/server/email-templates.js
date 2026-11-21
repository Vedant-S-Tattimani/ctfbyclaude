// The emails fs0cie1y sends. Each returns { subject, text, html }; links come from Firebase's action-link generator.
const escHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function layout(title, intro, buttonLabel, link, outro) {
  const url = escHtml(link);
  return `<!doctype html><html><body style="margin:0;padding:24px;background:#f4f4f2;font-family:Arial,Helvetica,sans-serif;color:#141414">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border:2px solid #141414">
<tr><td style="padding:28px 28px 8px;font-family:'Courier New',monospace;font-size:20px;font-weight:bold">fs0cie1y</td></tr>
<tr><td style="padding:8px 28px 0"><h1 style="font-size:20px;margin:0 0 12px">${escHtml(title)}</h1>
<p style="font-size:15px;line-height:1.5;margin:0 0 20px">${escHtml(intro)}</p>
<a href="${url}" style="display:inline-block;background:#141414;color:#ffffff;text-decoration:none;padding:12px 20px;font-weight:bold">${escHtml(buttonLabel)}</a>
<p style="font-size:13px;line-height:1.5;color:#555;margin:20px 0 0">${escHtml(outro)}</p>
<p style="font-size:12px;color:#777;word-break:break-all;margin:16px 0 28px">Button not working? Paste this link into your browser:<br>${url}</p></td></tr>
</table></td></tr></table></body></html>`;
}

/** @param {string} link */
export function verifyEmail(link) {
  const intro = 'Confirm this is your email address to finish setting up your fs0cie1y account and register for competitions.';
  const outro = "If you didn't create an account, you can ignore this email.";
  return {
    subject: 'Verify your email for fs0cie1y',
    text: `${intro}\n\nVerify your email: ${link}\n\n${outro}`,
    html: layout('Verify your email', intro, 'Verify email', link, outro),
  };
}

/** @param {string} link */
export function resetPassword(link) {
  const intro = 'Someone asked to reset the password for your fs0cie1y account. Use the button below to choose a new one. The link expires in 1 hour.';
  const outro = "If you didn't ask for this, ignore this email. Your password stays the same.";
  return {
    subject: 'Reset your fs0cie1y password',
    text: `${intro}\n\nReset your password: ${link}\n\n${outro}`,
    html: layout('Reset your password', intro, 'Reset password', link, outro),
  };
}
