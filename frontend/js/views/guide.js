// Guide: how to sign in, compete, run teams and host events, plus searchable FAQs.
import { route, onChange } from '../core.js';
import { esc, icon } from '../ui.js';

const L = (href, text) => `<a class="link" href="#${href}">${text}</a>`;

// Each section: id, title, icon, short intro, numbered steps, optional tips.
const SECTIONS = [
  { id: 'start', title: 'Create your account', icon: 'user', intro: 'Everything starts with a free account.', steps: [
    `Open ${L('/signup', 'Create account')} and choose a username (3–20 letters, numbers or underscores), your email and a password of at least 10 characters.`,
    'Verify your email with the link we send you. You must verify before you can register for competitions or create an organization.',
    'Finish onboarding: pick your experience level and the categories you like. You can change these later in Settings.',
  ] },
  { id: 'login', title: 'Sign in', icon: 'lock', intro: 'Use your username or email.', steps: [
    `Open ${L('/login', 'Sign in')} and enter your username or email and your password.`,
    'If two-factor authentication is on, enter the 6-digit code from your authenticator app.',
    `Forgot your password? Use ${L('/forgot', 'Reset password')}; the reset link is valid for 2 hours and signs you out everywhere else.`,
  ], tips: ['After too many wrong attempts sign-in is paused for a few minutes. Wait, then try again.'] },
  { id: 'security', title: 'Keep your account safe', icon: 'shield', intro: 'Two-factor authentication and sessions.', steps: [
    `In ${L('/settings', 'Settings')}, start two-factor setup and add the secret to an authenticator app (Google Authenticator, Authy, 1Password…).`,
    'Enter the current code to turn it on. From then on, every sign-in asks for a code.',
    'Settings also lists every signed-in device. Sign out of the ones you don’t recognise, or all of them at once.',
  ] },
  { id: 'teams', title: 'Teams', icon: 'users', intro: 'Most competitions are played in teams.', steps: [
    `Go to ${L('/teams', 'Teams')} and create a team. You become its owner.`,
    'Invite people by username, or share the team’s invite code so they can join with it.',
    'Owners can promote members to captain, remove members and transfer ownership. Owners and captains can register the team for events.',
  ], tips: ['Rosters are locked while your team is playing a live competition.', 'You can belong to up to 10 teams, but only one team per competition.'] },
  { id: 'compete', title: 'Join a competition', icon: 'grid', intro: 'Find an event and register.', steps: [
    `Browse ${L('/events', 'Competitions')}. Each event shows its dates, format, team size and how registration works.`,
    'Open the event and register — alone for individual events, or with a team you own or captain for team events.',
    'Some events need organizer approval (you’ll see “Awaiting approval”) and invitation-only events ask for a code from the organizers.',
    'When the event starts, open it and enter the arena.',
  ] },
  { id: 'arena', title: 'Solve challenges', icon: 'target', intro: 'The arena is where you play.', steps: [
    'Pick a challenge from the board. Read the description, download any files and, for instance challenges, start your team’s own instance.',
    'Find the flag (usually shaped like PREFIX{...}) and submit it. You’ll see whether it was correct, incorrect or already solved.',
    'Stuck? Hints can be unlocked; some are free and some cost points, which are taken from your team’s score.',
    'Watch your rank live on the scoreboard. Announcements from the organizers appear in the arena and as notifications.',
  ], tips: ['Submissions are limited to 5 per minute per challenge for each team.', 'Never share flags: per-team flags make sharing visible to organizers.'] },
  { id: 'practice', title: 'Practice and results', icon: 'book', intro: 'Learn at your own pace, keep your achievements.', steps: [
    `${L('/practice', 'Practice')} sets are always open and never affect official rankings.`,
    `Your ${L('/dashboard', 'Dashboard')} shows your competitions, solves and activity.`,
    `When an event ends, organizers can issue certificates. Find yours in ${L('/certificates', 'Certificates')}; anyone can check one at ${L('/verify', 'Verify certificate')}.`,
  ] },
  { id: 'host', title: 'Host a competition', icon: 'server', intro: 'For organizers and organization staff.', steps: [
    `Get organizer access: create an organization from ${L('/orgs', 'Organizations')} (you become its owner) or ask a platform admin.`,
    `Use ${L('/manage/new', 'Create event')}: a six-step wizard for basics, format, schedule, scoring, registration and review. Events start as drafts.`,
    'Add challenges with a static, case-insensitive, regex or per-team dynamic flag, plus hints, files and point values. Test each flag with the flag tester.',
    'Publish when the checklist is green. During the event, approve registrations, post announcements, watch submissions and review integrity signals.',
    'After the event, export CSVs and issue certificates.',
  ] },
];

const FAQ = [
  ['I didn’t get the verification email.', 'Open Settings or the onboarding page and resend the link (up to 3 per hour). Check your spam folder. If it still doesn’t arrive, contact the platform admin.'],
  ['Can I sign in with my email instead of my username?', 'Yes. The sign-in form accepts either.'],
  ['I lost my phone with the authenticator app.', 'Contact the platform admin to confirm your identity and restore access. Afterwards, set up two-factor again on your new device.'],
  ['Why can’t I register for a competition?', 'Common reasons: your email isn’t verified, registration has closed, your team is too small or too large for the event, a teammate is already registered with another team, or you are on the event’s staff.'],
  ['My registration says “Awaiting approval”.', 'This event reviews registrations. The organizers will approve or decline it and you’ll get a notification either way.'],
  ['How is the score calculated?', 'Dynamic challenges are worth less as more teams solve them, and every solver receives the current value. Some events add a first-blood bonus. Paid hints subtract their cost. Ties go to the team that reached the score first.'],
  ['Why is the scoreboard frozen?', 'Some events freeze the public scoreboard near the end to keep the finish exciting. Final results appear when the event ends.'],
  ['My flag is right but marked incorrect.', 'Check for extra spaces, the exact prefix and capitalisation. Flags are case-sensitive unless the challenge says otherwise. If you are sure, contact the organizers.'],
  ['“Too many attempts” when submitting.', 'Each team can submit 5 times per minute per challenge. Wait for the timer shown and try again.'],
  ['Do practice points count toward the leaderboard?', 'No. Practice is tracked separately and never changes official rankings.'],
  ['Can I leave or delete a team?', 'Members can leave any time except during a live competition. The owner must transfer ownership before leaving. A team with competition history can’t be deleted, so results stay on scoreboards.'],
  ['How do I host my own CTF?', 'Create an organization and you can host events through it right away. See “Host a competition” above.'],
  ['What happens if someone is caught sharing flags?', 'The system raises an integrity signal for organizers. Nothing is penalised automatically: organizers review the evidence, decide, and the team is told how to appeal.'],
  ['How do I verify a certificate?', 'Enter the certificate ID (CA-XXXX-XXXX-XXXX) on the Verify certificate page.'],
];

const sectionHtml = (s) => `<section class="cells guide-sec" id="g-${s.id}" data-guide-item data-text="${esc((s.title + ' ' + s.intro + ' ' + s.steps.join(' ') + ' ' + (s.tips || []).join(' ')).replace(/<[^>]+>/g, '').toLowerCase())}">
  <div><div class="cell-h"><h2 class="row" style="gap:8px">${icon(s.icon, 15)}${esc(s.title)}</h2></div>
  <div class="cell stack"><p class="dim">${esc(s.intro)}</p>
    <ol class="guide-steps">${s.steps.map((x) => `<li>${x}</li>`).join('')}</ol>
    ${s.tips ? `<div class="notice info">${icon('info')}<div>${s.tips.map(esc).join('<br>')}</div></div>` : ''}</div></div></section>`;

const faqHtml = ([q, a]) => `<details class="faq" data-guide-item data-text="${esc((q + ' ' + a).toLowerCase())}"><summary>${esc(q)}</summary><p>${esc(a)}</p></details>`;

route('/guide', { title: 'Guide', view: () => `<div class="page guide">
  <div class="pagehead"><div><h1>Guide</h1><p>How to sign in, compete, build a team and host your own competition, plus answers to common questions.</p></div>
    <a class="btn" href="/guides/fs0cie1y-user-guide.pdf" download>${icon('download', 14)}User guide (PDF)</a></div>
  <div class="guide-layout">
    <nav class="guide-toc" aria-label="Guide contents"><div class="label">On this page</div>
      ${SECTIONS.map((s) => `<a href="#/guide" data-jump="g-${s.id}">${esc(s.title)}</a>`).join('')}<a href="#/guide" data-jump="g-faq">FAQs</a></nav>
    <div class="stack" style="gap:18px;min-width:0">
      <input class="input" type="search" placeholder="Search the guide and FAQs…" aria-label="Search the guide" data-input="guidesearch">
      ${SECTIONS.map(sectionHtml).join('')}
      <section class="cells" id="g-faq"><div><div class="cell-h"><h2 class="row" style="gap:8px">${icon('info', 15)}Frequently asked questions</h2></div>
        <div class="cell faq-list">${FAQ.map(faqHtml).join('')}</div></div></section>
      <div class="empty" id="guide-none" hidden><b>Nothing matches your search.</b>Try other words, or ask the organizers of your event.</div>
    </div>
  </div></div>` });

onChange('guidesearch', (el) => {
  const q = el.value.trim().toLowerCase();
  let shown = 0;
  document.querySelectorAll('[data-guide-item]').forEach((n) => {
    const hit = !q || n.dataset.text.includes(q);
    n.hidden = !hit; if (hit) shown++;
    if (n.tagName === 'DETAILS') n.open = !!q && hit;
  });
  document.getElementById('g-faq').hidden = !!q && !document.querySelector('#g-faq [data-guide-item]:not([hidden])');
  document.getElementById('guide-none').hidden = shown > 0;
});
// The router owns the hash, so contents links scroll instead of navigating.
document.addEventListener('click', (e) => {
  const a = e.target.closest('[data-jump]'); if (!a) return;
  e.preventDefault(); document.getElementById(a.dataset.jump)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
});
