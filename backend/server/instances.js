// Per-team challenge instances. Providers:
//   none   — instance challenges report that instances are not configured (honest default)
//   docker — runs `docker run` locally with resource limits and the team's dynamic flag in $FLAG
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from './config.js';
import { col, findOne, find, count, insert, update, now } from './db.js';
import { HttpError } from './lib.js';
import { dynamicFlag } from './core.js';

const exec = promisify(execFile);
const IMAGE_RE = /^[a-z0-9][a-z0-9._\/:@-]{0,200}$/i;

export function instanceView(i) {
  if (!i) return null;
  return { id: i.id, status: i.status, host: i.host, port: i.port, expiresAt: i.expires_at, extensions: i.extensions, error: i.error, provider: i.provider };
}
export function currentInstance(challengeId, teamId) {
  return findOne('instances', { challenge_id: challengeId, team_id: teamId, status: { $in: ['starting', 'running', 'error'] } }, { sort: { id: -1 } });
}

export async function startInstance(c, teamId, userId) {
  if (!c.instance_image) throw new HttpError(400, 'This challenge does not use instances.');
  if (config.instanceProvider === 'none') throw new HttpError(503, 'Instances are not configured on this server. Ask the organizers, or set INSTANCE_PROVIDER=docker.');
  const existing = await currentInstance(c.id, teamId);
  if (existing && existing.status !== 'error') return existing;
  if (existing) await update('instances', { id: existing.id }, { status: 'stopped' });
  const active = await count('instances', { team_id: teamId, status: { $in: ['starting', 'running'] } });
  if (active >= config.instanceMaxPerTeam) throw new HttpError(429, `Your team already has ${active} running instances. Stop one first.`);
  if (!IMAGE_RE.test(c.instance_image)) throw new HttpError(400, 'Invalid instance image name.');

  const id = await insert('instances', { challenge_id: c.id, team_id: teamId, user_id: userId, provider: config.instanceProvider, container_id: null,
    host: null, port: null, status: 'starting', error: null, extensions: 0, expires_at: null, created_at: now() });
  try {
    const port = c.instance_port || 80;
    const flag = c.flag_type === 'dynamic' ? dynamicFlag(c, teamId) : '';
    const { stdout } = await exec('docker', ['run', '-d', '--rm', '--memory', '256m', '--cpus', '0.5', '--pids-limit', '128',
      '--label', 'cipherarena=1', '--label', `ca.instance=${id}`, '-e', `FLAG=${flag}`, '-p', `0:${port}`, c.instance_image], { timeout: 60_000 });
    const cid = stdout.trim().slice(0, 64);
    const { stdout: portOut } = await exec('docker', ['port', cid, String(port)], { timeout: 10_000 });
    const hostPort = Number(portOut.trim().split('\n')[0].split(':').pop());
    await update('instances', { id }, { container_id: cid, host: config.instanceHost, port: hostPort, status: 'running', expires_at: now() + c.instance_minutes * 60_000 });
  } catch (err) {
    await update('instances', { id }, { status: 'error', error: 'The instance failed to start. No quota was used; try again or report it to the organizers.' });
    console.error('[instances] start failed:', err.message);
  }
  return findOne('instances', { id });
}
export async function stopInstance(inst) {
  if (inst.container_id && inst.provider === 'docker') { try { await exec('docker', ['stop', '-t', '3', inst.container_id], { timeout: 20_000 }); } catch (e) { console.error('[instances] stop failed:', e.message); } }
  await update('instances', { id: inst.id }, { status: 'stopped' });
}
export async function extendInstance(inst, c) {
  if (inst.status !== 'running') throw new HttpError(400, 'Only running instances can be extended.');
  if (inst.extensions >= 2) throw new HttpError(400, 'This instance has used both extensions.');
  const exp = Math.max(inst.expires_at, now()) + 30 * 60_000;
  await col('instances').updateOne({ id: inst.id }, { $set: { expires_at: Math.min(exp, now() + (c.instance_minutes + 30) * 60_000) }, $inc: { extensions: 1 } });
}
// Reaper: stop expired instances every 30s (only when instances are enabled).
export function startReaper() {
  if (config.instanceProvider === 'none') return;
  setInterval(async () => {
    try { for (const i of await find('instances', { status: 'running', expires_at: { $lt: now() } })) await stopInstance(i); }
    catch (e) { console.error('[instances] reaper failed:', e.message); }
  }, 30_000).unref();
}
