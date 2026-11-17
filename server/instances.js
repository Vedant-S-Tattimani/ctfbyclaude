// Per-team challenge instances. Providers:
//   none   — instance challenges report that instances are not configured (honest default)
//   docker — runs `docker run` locally with resource limits and the team's dynamic flag in $FLAG
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from './config.js';
import { one, all, run, now } from './db.js';
import { HttpError } from './lib.js';
import { dynamicFlag } from './core.js';

const exec = promisify(execFile);
const IMAGE_RE = /^[a-z0-9][a-z0-9._\/:@-]{0,200}$/i;

export function instanceView(i) {
  if (!i) return null;
  return { id: i.id, status: i.status, host: i.host, port: i.port, expiresAt: i.expires_at, extensions: i.extensions, error: i.error, provider: i.provider };
}
export function currentInstance(challengeId, teamId) {
  return one("SELECT * FROM instances WHERE challenge_id=? AND team_id=? AND status IN ('starting','running','error') ORDER BY id DESC LIMIT 1", challengeId, teamId);
}

export async function startInstance(c, teamId, userId) {
  if (!c.instance_image) throw new HttpError(400, 'This challenge does not use instances.');
  if (config.instanceProvider === 'none') throw new HttpError(503, 'Instances are not configured on this server. Ask the organizers, or set INSTANCE_PROVIDER=docker.');
  const existing = currentInstance(c.id, teamId);
  if (existing && existing.status !== 'error') return existing;
  if (existing) run("UPDATE instances SET status='stopped' WHERE id=?", existing.id);
  const active = one("SELECT COUNT(*) n FROM instances WHERE team_id=? AND status IN ('starting','running')", teamId).n;
  if (active >= config.instanceMaxPerTeam) throw new HttpError(429, `Your team already has ${active} running instances. Stop one first.`);
  if (!IMAGE_RE.test(c.instance_image)) throw new HttpError(400, 'Invalid instance image name.');

  const id = run("INSERT INTO instances (challenge_id,team_id,user_id,provider,status,created_at) VALUES (?,?,?,?, 'starting', ?)", c.id, teamId, userId, config.instanceProvider, now()).lastInsertRowid;
  try {
    const port = c.instance_port || 80;
    const flag = c.flag_type === 'dynamic' ? dynamicFlag(c, teamId) : '';
    const { stdout } = await exec('docker', ['run', '-d', '--rm', '--memory', '256m', '--cpus', '0.5', '--pids-limit', '128',
      '--label', 'cipherarena=1', '--label', `ca.instance=${id}`, '-e', `FLAG=${flag}`, '-p', `0:${port}`, c.instance_image], { timeout: 60_000 });
    const cid = stdout.trim().slice(0, 64);
    const { stdout: portOut } = await exec('docker', ['port', cid, String(port)], { timeout: 10_000 });
    const hostPort = Number(portOut.trim().split('\n')[0].split(':').pop());
    run("UPDATE instances SET container_id=?, host=?, port=?, status='running', expires_at=? WHERE id=?", cid, config.instanceHost, hostPort, now() + c.instance_minutes * 60_000, id);
  } catch (err) {
    run("UPDATE instances SET status='error', error=? WHERE id=?", 'The instance failed to start. No quota was used; try again or report it to the organizers.', id);
    console.error('[instances] start failed:', err.message);
  }
  return one('SELECT * FROM instances WHERE id=?', id);
}
export async function stopInstance(inst) {
  if (inst.container_id && inst.provider === 'docker') { try { await exec('docker', ['stop', '-t', '3', inst.container_id], { timeout: 20_000 }); } catch (e) { console.error('[instances] stop failed:', e.message); } }
  run("UPDATE instances SET status='stopped' WHERE id=?", inst.id);
}
export function extendInstance(inst, c) {
  if (inst.status !== 'running') throw new HttpError(400, 'Only running instances can be extended.');
  if (inst.extensions >= 2) throw new HttpError(400, 'This instance has used both extensions.');
  const exp = Math.max(inst.expires_at, now()) + 30 * 60_000;
  run('UPDATE instances SET expires_at=?, extensions=extensions+1 WHERE id=?', Math.min(exp, now() + (c.instance_minutes + 30) * 60_000), inst.id);
}
// Reaper: stop expired instances every 30s.
setInterval(async () => { for (const i of all("SELECT * FROM instances WHERE status='running' AND expires_at < ?", now())) await stopInstance(i); }, 30_000).unref();
