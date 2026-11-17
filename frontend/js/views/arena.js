// Competition workspace: board, challenge, instances, submissions, scoreboard, projector, announcements.
import { api, route, state, go, refresh, ctx, onAct, onForm, onChange, sideExtra, streamHandlers } from '../core.js';
import { esc, fmt, icon, tag, phaseTag, dtFmt, timeFmt, ago, clock, md, av, catCode, catName, diff, DIFF, toast, confirmDlg, copy, multiLine, CAT } from '../ui.js';

const A = { shell: 'arena', auth: true };
let BOARD = null; const BF = { cat: '', state: '', q: '' };

function statusline(slug, b) {
  const t = Date.now(); const ended = b.phase === 'ended';
  return `<div class="statusline"><div>${b.phase === 'live' ? '<span class="live-dot"></span>' : ''}<span class="k">Event</span>${esc(sideExtra.arena?.name || slug)}</div>
    <div><span class="k">${ended ? 'Ended' : 'Ends in'}</span><span id="cd" data-end="${b.endsAt}">${ended ? dtFmt(b.endsAt) : clock(b.endsAt - t)}</span></div>
    ${b.team ? `<div><span class="k">Rank</span>#${b.team.rank} of ${b.team.of}</div><div><span class="k">Points</span>${fmt(b.team.points)}</div><div><span class="k">Solved</span>${b.team.solved}/${b.challenges.filter((c) => !c.hidden).length}</div>` : '<div><span class="k">Mode</span>staff preview</div>'}
    ${!b.accepting ? '<div class="warn">Submissions paused by organizers</div>' : ''}</div>`;
}
setInterval(() => { const el = document.getElementById('cd'); if (el && el.dataset.end) { const left = Number(el.dataset.end) - Date.now(); if (left > 0) el.textContent = clock(left); } }, 1000);

async function loadBoard(slug) {
  const [b, ev] = await Promise.all([api(`/events/${slug}/challenges`), sideExtra.arena?.slug === slug ? null : api(`/events/${slug}`)]);
  if (ev) sideExtra.arena = { slug, name: ev.event.name };
  sideExtra.arena.team = b.team; BOARD = b; return b;
}
function tile(c, slug) {
  const lockText = c.lockReason?.reason === 'scheduled' ? `Releases ${dtFmt(c.lockReason.at)}` : c.lockReason?.reason === 'locked' ? `Solve ${c.lockReason.after} first` : c.hidden ? 'Hidden from players' : '';
  return `<a class="tile ${c.solved ? 'solved' : ''} ${!c.available && !c.hidden ? 'locked' : ''} ${c.hidden ? 'hiddenc' : ''}" href="${c.available || c.hidden ? `#/arena/${esc(slug)}/c/${c.id}` : '#'}" ${!c.available && !c.hidden ? `data-act="locked" data-msg="${esc(lockText)}"` : ''} aria-label="${esc(c.name)}, ${c.value} points, ${c.solved ? 'solved' : c.available ? 'open' : 'locked'}">
    <span class="corner">${c.solved ? icon('check', 14) : !c.available ? icon('lock', 13) : c.kind === 'instance' ? icon('server', 13) : icon('file', 13)}</span>
    <div class="pts">${c.value}</div><div class="nm">${esc(c.name)}</div>
    <div class="meta"><span>${diff(c.difficulty)} ${c.solves} solve${c.solves === 1 ? '' : 's'}</span>${c.firstBloodMine ? '<span class="fb">FIRST BLOOD</span>' : !c.available ? `<span>${esc(lockText.split(' ')[0])}</span>` : ''}</div></a>`;
}
function boardHtml(slug) {
  const q = BF.q.toLowerCase();
  const list = BOARD.challenges.filter((c) => (!BF.cat || c.category === BF.cat) && (!BF.state || (BF.state === 'solved' ? c.solved : !c.solved)) && (!q || c.name.toLowerCase().includes(q)));
  if (!list.length) return '<div class="panel"><div class="empty"><b>No challenges match.</b>Clear the filters to see the full board.</div></div>';
  const cats = [...new Set(list.map((c) => c.category))];
  return `<div class="board">${cats.map((cat) => { const cl = list.filter((c) => c.category === cat); return `<div class="col"><div class="col-h"><b>${esc(catName(cat))}</b><span class="mono xs faint">${cl.filter((c) => c.solved).length}/${cl.length}</span></div>${cl.map((c) => tile(c, slug)).join('')}</div>`; }).join('')}</div>`;
}
route('/arena/:slug', { ...A, title: 'Challenges', view: async ({ params }) => {
  const b = await loadBoard(params.slug); const cats = [...new Set(b.challenges.map((c) => c.category))];
  return `${statusline(params.slug, b)}<div class="page">${b.pinned ? `<div class="notice warn" style="margin-bottom:18px">${icon('alert')}<div><b>${esc(b.pinned.title)}.</b> ${esc(b.pinned.body)}</div></div>` : ''}
    <div class="row wrap between" style="gap:12px;margin-bottom:16px"><h1>Challenges</h1><div class="row wrap" style="gap:8px">
      <input class="input" style="width:200px" placeholder="Search challenges" value="${esc(BF.q)}" data-input="bq" aria-label="Search challenges">
      <select class="select" style="width:auto" data-change="bcat" aria-label="Category"><option value="">All categories</option>${cats.map((c) => `<option value="${c}" ${BF.cat === c ? 'selected' : ''}>${esc(catName(c))}</option>`).join('')}</select>
      <div class="seg">${[['', 'All'], ['unsolved', 'Unsolved'], ['solved', 'Solved']].map(([v, l]) => `<button class="${BF.state === v ? 'on' : ''}" data-act="bstate" data-v="${v}">${l}</button>`).join('')}</div></div></div>
    <div class="row wrap small dim" style="gap:16px;margin-bottom:14px"><span class="row">${icon('check', 13, 'ok')}Solved</span><span class="row">${icon('lock', 13)}Locked or scheduled</span><span class="row">${icon('server', 13)}Per-team instance</span><span class="row">${icon('file', 13)}Files</span><span class="row">${diff(3)}Difficulty</span><span class="fb">FIRST BLOOD</span><span>= your team was first</span></div>
    <div id="board">${boardHtml(params.slug)}</div></div>`;
} });
onAct('locked', (el) => toast(el.dataset.msg || 'This challenge is locked.', 'info'));
onAct('bstate', (el) => { BF.state = el.dataset.v; refresh(); });
onChange('bcat', (el) => { BF.cat = el.value; document.getElementById('board').innerHTML = boardHtml(ctx.params.slug); });
onChange('bq', (el) => { BF.q = el.value; document.getElementById('board').innerHTML = boardHtml(ctx.params.slug); });

/* ---------- challenge ---------- */
let CH = null;
function instanceBox(d, slug) {
  const i = d.instance; const base = `/events/${slug}/challenges/${d.challenge.id}/instance`;
  if (!d.instancesEnabled) return `<div class="notice">${icon('info')}<div>This challenge runs on a per-team instance, but instances are not enabled on this server. The organizers can enable them with <span class="mono">INSTANCE_PROVIDER=docker</span>.</div></div>`;
  if (!i || i.status === 'stopped') return `<p class="dim small">Each team gets an isolated container with its own flag. It expires after a fixed time and can be extended twice.</p><button class="btn primary" data-act="inst-start" data-base="${base}" style="margin-top:12px">${icon('play')}Launch instance</button>`;
  if (i.status === 'starting') return `<div class="row">${'<span class="spin"></span>'}<span>Starting your instance…</span></div>`;
  if (i.status === 'error') return `<div class="notice err">${icon('alert')}<div>${esc(i.error)}</div></div><button class="btn" data-act="inst-start" data-base="${base}" style="margin-top:12px">${icon('refresh')}Try again</button>`;
  return `<div class="stack"><div class="copyline"><span>${esc(i.host)}:${i.port}</span><button class="btn ghost sm" data-act="copy" data-text="${esc(i.host)}:${i.port}" aria-label="Copy address">${icon('copy')}</button></div>
    <div class="copyline"><span>nc ${esc(i.host)} ${i.port}</span><button class="btn ghost sm" data-act="copy" data-text="nc ${esc(i.host)} ${i.port}" aria-label="Copy command">${icon('copy')}</button></div>
    <div class="row between small"><span class="dim">Expires in</span><span class="mono" id="icd" data-end="${i.expiresAt}">${clock(i.expiresAt - Date.now())}</span></div><div class="bar"><i id="ibar" style="width:${Math.min(100, ((i.expiresAt - Date.now()) / 2700000) * 100)}%"></i></div>
    <div class="row wrap"><button class="btn sm" data-act="inst-extend" data-base="${base}" ${i.extensions >= 2 ? 'disabled' : ''}>${icon('clock')}Extend 30 min</button><button class="btn sm" data-act="inst-restart" data-base="${base}">${icon('refresh')}Restart</button><button class="btn danger sm" data-act="inst-stop" data-base="${base}">${icon('stop')}Stop</button><span class="xs faint">${2 - i.extensions} extension${i.extensions === 1 ? '' : 's'} left</span></div></div>`;
}
setInterval(() => { const el = document.getElementById('icd'); if (el) { const left = Number(el.dataset.end) - Date.now(); el.textContent = clock(left); const b = document.getElementById('ibar'); if (b) b.style.width = `${Math.max(0, Math.min(100, (left / 2700000) * 100))}%`; if (left <= 0) refresh(); } }, 1000);
const RES = { correct: 'Correct', incorrect: 'Incorrect', already: 'Already solved' };
route('/arena/:slug/c/:id', { ...A, view: async ({ params }) => {
  const [, d] = await Promise.all([loadBoard(params.slug), api(`/events/${params.slug}/challenges/${params.id}`)]); CH = d; const c = d.challenge;
  const idx = BOARD.challenges.findIndex((x) => x.id === c.id); const nav = (o) => BOARD.challenges[(idx + o + BOARD.challenges.length) % BOARD.challenges.length];
  const canSubmit = d.accepting && !d.solved;
  return { title: c.name, html: `${statusline(params.slug, BOARD)}<div class="page"><div class="row between" style="margin-bottom:16px"><a class="btn ghost sm" href="#/arena/${esc(params.slug)}">${icon('arrowL')}Board</a><div class="row"><a class="btn sm" href="#/arena/${esc(params.slug)}/c/${nav(-1).id}" aria-label="Previous challenge">${icon('arrowL')}</a><a class="btn sm" href="#/arena/${esc(params.slug)}/c/${nav(1).id}" aria-label="Next challenge">${icon('arrowR')}</a></div></div>
  <div class="cells c-main"><div>
    <div class="cell"><div class="row wrap">${tag(catCode(c.category))}<span class="small dim">${esc(catName(c.category))}</span><span class="small dim">·</span>${diff(c.difficulty)}<span class="small dim">${DIFF[c.difficulty]}</span>${d.solved ? tag('Solved', 'ok') : ''}</div>
      <div class="row between top" style="margin-top:14px;gap:20px"><div><h1 style="font-size:34px">${esc(c.name)}</h1><div class="small dim" style="margin-top:6px">${c.author ? `by <span class="mono">@${esc(c.author)}</span> · ` : ''}${c.solves} solve${c.solves === 1 ? '' : 's'}${c.firstBlood ? ` · first blood <b style="color:var(--text)">${esc(c.firstBlood)}</b>` : ''}</div></div>
      <div style="text-align:right"><div class="mono" style="font-size:44px;font-weight:600;line-height:1;letter-spacing:-0.04em">${c.value}</div><div class="xs dim">${c.scoring === 'dynamic' ? `dynamic · floor ${c.valueMin}` : 'static'}</div></div></div></div>
    <div class="cell prose">${md(c.description)}</div>
    ${c.kind === 'instance' ? `<div class="cell-h" style="border-top:1px solid var(--rule)"><h3>Instance</h3>${d.instance?.status === 'running' ? tag('Running', 'ok') : ''}</div><div class="cell" id="inst">${instanceBox(d, params.slug)}</div>` : ''}
    ${d.attachments.length ? `<div class="cell-h" style="border-top:1px solid var(--rule)"><h3>Files</h3><span class="xs faint">SHA-256 shown so you can verify downloads</span></div><div class="cell stack tight">${d.attachments.map((a) => `<div class="row between" style="border:1px solid var(--rule);padding:10px 12px;background:var(--surface-alt);border-radius:var(--r)"><div class="row trunc">${icon('file')}<div class="trunc"><div class="mono small">${esc(a.filename)}</div><div class="mono xs faint trunc">${fmt(Math.ceil(a.size / 1024))} KB · ${esc(a.sha256)}</div></div></div><a class="btn sm" href="/api/events/${esc(params.slug)}/attachments/${a.id}" download>${icon('download')}Download</a></div>`).join('')}</div>` : ''}
    <div class="cell-h" style="border-top:1px solid var(--rule)"><h3>Your team's attempts</h3><span class="xs faint">Submitted values are masked</span></div>
    <div class="tablewrap">${d.submissions.length ? `<table class="t"><tbody>${d.submissions.map((s) => `<tr><td class="mono small">${timeFmt(s.created_at)}</td><td class="small">@${esc(s.username)}</td><td class="mono xs faint">${esc(s.value_masked)}</td><td>${tag(RES[s.result], s.result === 'correct' ? 'ok' : s.result === 'incorrect' ? 'crit' : 'info')}</td></tr>`).join('')}</tbody></table>` : '<div class="empty xs">No attempts yet.</div>'}</div></div>
  <div><div class="cell-h"><h3>Submit flag</h3>${d.solved ? tag('Solved', 'ok') : ''}</div>
    <div class="cell">${d.solved ? `<div class="fbk already">${icon('check')}<div><b>Solved</b><div class="small">by @${esc(d.solved.by)} at ${dtFmt(d.solved.at)}. More submissions won't change your score.</div></div></div>` : ''}
      <form class="stack" data-form="submit" style="${d.solved ? 'margin-top:12px' : ''}" novalidate><label class="flabel" for="flag">Flag</label><input id="flag" name="flag" class="input flag" placeholder="CIPHERARENA{...}" autocomplete="off" spellcheck="false" ${d.accepting ? '' : 'disabled'} required>
        <button class="btn primary lg" type="submit" ${d.accepting ? '' : 'disabled'}>${icon('flag')}${d.solved ? 'Submit anyway' : 'Submit'}</button></form>
      <div id="fbk" style="margin-top:12px" aria-live="polite">${!d.accepting ? `<div class="fbk unavailable">${icon('lock')}<div><b>Submissions are closed</b><div class="small dim">The event has ended or organizers paused submissions.</div></div></div>` : ''}</div>
      <div class="xs faint" style="margin-top:10px">${d.rateLimit.perMinute} attempts per minute per challenge · ${Math.max(0, d.rateLimit.perMinute - d.rateLimit.used)} left this minute</div></div>
    ${d.hints.length ? `<div class="cell-h" style="border-top:1px solid var(--rule)"><h3>Hints</h3><span class="xs faint">Costs come off your team's score</span></div><div class="cell stack">${d.hints.map((h, i) => `<div style="border:1px solid var(--rule);padding:10px 12px;background:var(--surface-alt);border-radius:var(--r)"><div class="row between"><span class="row small">${icon('bulb', 14)}Hint ${i + 1}</span>${h.content !== null ? tag(h.cost ? `−${h.cost} paid` : 'Free', h.cost ? 'warn' : 'ok') : `<button class="btn sm" data-act="hint" data-id="${h.id}" data-cost="${h.cost}">Unlock · −${h.cost}</button>`}</div>${h.content !== null ? `<p class="small" style="margin-top:8px">${esc(h.content)}</p>` : ''}</div>`).join('')}</div>` : ''}
    <div class="cell"><dl class="kv" style="grid-template-columns:90px 1fr;font-size:12.5px"><dt>Reference</dt><dd class="mono">${esc(c.ref)}</dd><dt>Type</dt><dd>${c.kind === 'instance' ? 'Per-team instance' : 'Files / offline'}</dd>${c.tags.length ? `<dt>Tags</dt><dd>${c.tags.map((t) => esc(t)).join(', ')}</dd>` : ''}</dl></div></div></div></div>`,
    mount: () => { if (!d.solved) document.getElementById('flag')?.focus(); } };
} });
onForm('submit', async (f, fm) => {
  const box = document.getElementById('fbk'); const v = f.flag.trim(); const input = fm.querySelector('#flag');
  if (!v) { input.setAttribute('aria-invalid', 'true'); box.innerHTML = '<div class="fbk format"><div>Enter a flag to submit.</div></div>'; return; }
  if (!/^[A-Za-z0-9_]+\{.*\}$/s.test(v)) { box.innerHTML = `<div class="fbk format">${icon('info')}<div><b>Check the format</b><div class="small dim">Flags look like <span class="mono">CIPHERARENA{...}</span>. This attempt was not sent.</div></div></div>`; return; }
  const { slug } = ctx.params; const r = await api(`/events/${slug}/challenges/${CH.challenge.id}/submit`, { method: 'POST', body: { flag: v } });
  const title = { correct: r.firstBlood ? 'Correct — first blood' : 'Correct', incorrect: 'Incorrect', already: 'Already solved', ratelimited: 'Slow down', unavailable: 'Not counted' }[r.result];
  const ic = { correct: 'check', incorrect: 'x', already: 'info', ratelimited: 'clock', unavailable: 'lock' }[r.result];
  box.innerHTML = `<div class="fbk ${r.result} ${r.result === 'incorrect' ? 'shake' : ''}">${icon(ic)}<div><b>${title}</b><div class="small">${esc(r.message)}${r.result === 'correct' ? ` Your team is now #${r.rank} with ${fmt(r.points)} points.` : ''}</div></div></div>`;
  if (r.result === 'correct') { toast(`${CH.challenge.name} solved`); const keep = box.innerHTML; await refresh(); document.getElementById('fbk').innerHTML = keep; }
  else { input.select(); if (r.result === 'ratelimited') { const btn = fm.querySelector('button[type=submit]'); setTimeout(() => { btn.disabled = true; }, 0); setTimeout(() => { btn.disabled = false; }, (r.retryAfter || 30) * 1000); } }
});
onAct('hint', async (el) => {
  if (!(await confirmDlg('Unlock this hint?', `This costs your team <b>${el.dataset.cost} points</b>, for everyone on the team. It can't be undone.`, `Unlock for −${el.dataset.cost}`))) return;
  await api(`/events/${ctx.params.slug}/challenges/${CH.challenge.id}/hints/${el.dataset.id}/unlock`, { method: 'POST' }); toast('Hint unlocked.'); refresh();
});
async function instCall(el, method, suffix = '') { el.disabled = true; el.innerHTML = '<span class="spin"></span>'; try { await api(`${el.dataset.base}${suffix}`, { method }); } finally { refresh(); } }
onAct('inst-start', (el) => instCall(el, 'POST'));
onAct('inst-extend', (el) => instCall(el, 'POST', '/extend'));
onAct('inst-stop', async (el) => { if (await confirmDlg('Stop the instance?', 'This frees one of your team\'s instance slots. You can launch again any time.', 'Stop', true)) instCall(el, 'DELETE'); });
onAct('inst-restart', async (el) => { if (!(await confirmDlg('Restart the instance?', 'The container is reset to its initial state.', 'Restart'))) return; await api(el.dataset.base, { method: 'DELETE' }); instCall(el, 'POST'); });

/* ---------- scoreboard ---------- */
let SB = null; let SBQ = ''; let prevRanks = {};
const SERIES = ['#e02149', '#ece5e6', '#7d9ce0', '#dba141', '#45b67d'];
function sbRows(rows, big = false) {
  return rows.map((r) => { const prev = prevRanks[r.name]; const delta = prev ? prev - r.rank : 0;
    return `<tr class="${r.mine ? 'mine' : ''} ${delta ? 'flash' : ''}"><td class="mono" style="width:56px;${r.rank <= 3 ? 'color:var(--text);font-weight:600' : 'color:var(--faint)'}">${String(r.rank).padStart(2, '0')}</td>
      <td class="mono xs" style="width:40px">${delta > 0 ? `<span class="ok">▲${delta}</span>` : delta < 0 ? `<span class="crit">▼${-delta}</span>` : ''}</td>
      <td><span class="row">${big ? '' : av(r.name)}${r.slug ? `<a href="#/t/${esc(r.slug)}">${esc(r.name)}</a>` : esc(r.name)}${r.mine ? tag('You', 'you') : ''}<span class="mono xs faint">${esc(r.country || '')}</span></span></td>
      <td class="num">${r.solved}</td><td class="num hide-m">${r.firstBloods ? `<span class="fb">${r.firstBloods}</span>` : '<span class="faint">0</span>'}</td><td class="mono small dim hide-m">${r.lastSolve ? ago(r.lastSolve) : '—'}</td><td class="num" style="font-weight:600">${fmt(r.points)}</td></tr>`; }).join('');
}
async function loadSB(slug) { if (SB) prevRanks = Object.fromEntries(SB.rows.map((r) => [r.name, r.rank])); SB = await api(`/events/${slug}/scoreboard`); return SB; }
route('/arena/:slug/scoreboard', { shell: 'arena', title: 'Scoreboard', view: async ({ params }) => {
  if (sideExtra.arena?.slug !== params.slug) { const ev = await api(`/events/${params.slug}`); sideExtra.arena = { slug: params.slug, name: ev.event.name }; }
  prevRanks = {}; SB = null; const s = await loadSB(params.slug); const q = SBQ.toLowerCase();
  const rows = s.rows.filter((r) => !q || r.name.toLowerCase().includes(q));
  return { title: `${s.name} scoreboard`, html: `<div class="page"><div class="pagehead"><div><div class="crumbs"><a href="#/events/${esc(params.slug)}">${esc(s.name.toUpperCase())}</a>/</div><h1>Scoreboard</h1><p class="row">${s.phase === 'live' ? '<span class="tag live">Live</span> Updates as flags are captured.' : phaseTag(s.phase)}${s.frozen ? ` ${tag('Frozen at ' + dtFmt(s.freezeAt), 'warn')} Solves after the freeze appear when the event ends.` : ''}</p></div>
    <div class="row"><a class="btn" href="#/projector/${esc(params.slug)}">${icon('max')}Projector mode</a></div></div>
    ${s.rows.length ? `<div class="cells c3" style="margin-bottom:20px">${s.rows.slice(0, 3).map((r, i) => `<div class="cell" style="box-shadow:inset 0 3px 0 ${['#d4af37', '#a9b0bb', '#b0754a'][i]}"><div class="label">${['First', 'Second', 'Third'][i]}</div><div class="row" style="margin-top:12px">${av(r.name, 'lg')}<div class="grow"><div style="font-weight:700;font-size:17px" class="trunc">${esc(r.name)}</div><div class="xs dim">${r.solved} solves · ${r.firstBloods} first bloods</div></div><div class="mono" style="font-size:26px;font-weight:600">${fmt(r.points)}</div></div></div>`).join('')}</div>` : ''}
    <div class="cells c-main"><div><div class="cell-h"><input class="input" style="max-width:260px" placeholder="Find a team" value="${esc(SBQ)}" data-input="sbq" aria-label="Find a team"><span class="mono small dim">${s.rows.length} on the board</span></div>
      <div class="tablewrap"><table class="t"><thead><tr><th>#</th><th>Δ</th><th>Team</th><th class="r">Solved</th><th class="r hide-m">First bl.</th><th class="hide-m">Last solve</th><th class="r">Points</th></tr></thead><tbody id="sbt">${sbRows(rows) || '<tr><td colspan="7"><div class="empty">Nobody has registered yet.</div></td></tr>'}</tbody></table></div></div>
    <div><div class="cell-h"><h3>Top five over time</h3></div><div class="cell" id="sbchart">${s.series.length ? multiLine(s.series.map((x, i) => ({ name: x.team, color: SERIES[i], width: i ? 1.4 : 2.2, points: x.points })), { t0: s.startsAt, t1: Math.min(Date.now(), s.endsAt) }) : '<div class="empty xs">No solves yet.</div>'}</div>
      <div class="cell-h" style="border-top:1px solid var(--rule)"><h3>Latest solves</h3></div><div id="recent">${recentHtml(s.recent)}</div></div></div></div>` };
} });
const recentHtml = (r) => r.map((x) => `<div class="row" style="padding:9px 20px;border-bottom:1px solid var(--rule);font-size:13px"><span class="mono xs faint" style="width:62px">${timeFmt(x.created_at)}</span><span class="grow trunc"><b>${esc(x.team)}</b> <span class="dim">solved</span> ${esc(x.challenge)}</span><span class="mono xs dim">${x.value}</span></div>`).join('') || '<div class="empty xs">No solves yet.</div>';
onChange('sbq', (el) => { SBQ = el.value; const q = SBQ.toLowerCase(); document.getElementById('sbt').innerHTML = sbRows(SB.rows.filter((r) => r.name.toLowerCase().includes(q))); });
route('/projector/:slug', { shell: 'bare', title: 'Projector', view: async ({ params }) => {
  prevRanks = {}; SB = null; const s = await loadSB(params.slug);
  return `<div class="proj"><div class="row between wrap" style="margin-bottom:28px;gap:20px"><div><div class="label">Live scoreboard</div><h1 style="font-size:40px;margin-top:6px">${esc(s.name)}</h1></div>
    <div class="row" style="gap:28px"><div style="text-align:right"><div class="label">${s.phase === 'ended' ? 'Ended' : 'Time left'}</div><div class="mono" id="cd" data-end="${s.endsAt}" style="font-size:40px;font-weight:600">${s.phase === 'ended' ? '00:00:00' : clock(s.endsAt - Date.now())}</div></div><a class="btn" href="#/arena/${esc(params.slug)}/scoreboard">Exit</a></div></div>
    <div class="cells" style="grid-template-columns:minmax(0,2fr) minmax(0,1fr)"><div><table class="t"><tbody id="sbt">${sbRows(s.rows.slice(0, 12), true)}</tbody></table></div><div class="hide-m"><div class="cell-h"><h3>Latest solves</h3></div><div id="recent">${recentHtml(s.recent.slice(0, 10))}</div></div></div>${s.frozen ? `<p class="warn mono" style="margin-top:16px">Scoreboard frozen at ${dtFmt(s.freezeAt)}</p>` : ''}</div>`;
} });
// live updates
streamHandlers.add(async (d) => {
  if (!ctx) return; const p = ctx.path;
  if ((d.type === 'solve' || d.type === 'scoreboard') && (p.endsWith('/scoreboard') || p.startsWith('/projector/'))) {
    const slug = ctx.params.slug; const s = await loadSB(slug); const big = p.startsWith('/projector/'); const q = SBQ.toLowerCase();
    const tb = document.getElementById('sbt'); if (tb) tb.innerHTML = sbRows(big ? s.rows.slice(0, 12) : s.rows.filter((r) => !q || r.name.toLowerCase().includes(q)), big);
    const rc = document.getElementById('recent'); if (rc) rc.innerHTML = recentHtml(big ? s.recent.slice(0, 10) : s.recent);
  }
  if (d.type === 'solve' && p.startsWith('/arena/') && !p.endsWith('/scoreboard')) {
    if (d.firstBlood) toast(`First blood: ${d.team} solved ${d.challenge}`, 'info');
    if (p === `/arena/${ctx.params.slug}`) { await loadBoard(ctx.params.slug); const b = document.getElementById('board'); if (b) b.innerHTML = boardHtml(ctx.params.slug); }
  }
  if (d.type === 'announcement' && p.endsWith('/news')) refresh();
});

route('/arena/:slug/news', { shell: 'arena', title: 'Announcements', view: async ({ params }) => {
  const d = await api(`/events/${params.slug}`); sideExtra.arena = { ...(sideExtra.arena || {}), slug: params.slug, name: d.event.name };
  return `<div class="page narrow"><div class="pagehead"><div><h1>Announcements</h1><p>From the ${esc(d.event.name)} organizers. New ones also arrive as notifications.</p></div></div>
    <div class="panel">${d.announcements.map((a) => `<article class="cell" style="border-bottom:1px solid var(--rule);${a.pinned ? 'box-shadow:inset 3px 0 0 var(--warn)' : ''}"><div class="row between"><h3>${esc(a.title)}</h3><span class="mono xs faint">${dtFmt(a.created_at)}</span></div>${a.pinned ? tag('Pinned', 'warn') : ''}<div class="prose small" style="margin-top:8px">${md(a.body)}</div></article>`).join('') || '<div class="empty">No announcements yet.</div>'}</div></div>`;
} });
