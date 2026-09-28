import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createConnection } from 'node:net';

export const MAX_REQUEST = 256 * 1024;
export const MAX_RESULT = 64 * 1024;
export const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
export function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}
export function errorResult(error) {
  return { ok: false, error: { code: error.code || 'BROWSER_ERROR', message: String(error.message || error).slice(0, 4000) } };
}
export function name(value, label = 'Name') {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,47}$/.test(value))
    fail('INVALID_ARGUMENT', `${label} must be 1–48 lowercase letters, numbers, underscores or hyphens, starting with a letter or number.`);
  return value;
}
export function webURL(value) {
  let url;
  try { url = new URL(value); } catch { fail('INVALID_ARGUMENT', 'Supply an absolute HTTP(S) URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    fail('INVALID_ARGUMENT', 'Supply an HTTP(S) URL without embedded credentials.');
  return url.href;
}
export function integer(value, fallback, min, max, label) {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(n) || n < min || n > max) fail('INVALID_ARGUMENT', `${label} must be an integer from ${min} to ${max}.`);
  return n;
}
export function paths(env = process.env) {
  const home = resolve(env.BROWSER_CHECK_HOME || join(env.XDG_DATA_HOME || join(homedir(), '.local/share'), 'browser-check'));
  const hash = createHash('sha256').update(home).digest('hex').slice(0, 12);
  // Keep Unix socket paths short. The directory is private to this OS user and data home.
  const runtime = join(tmpdir(), `browser-check-${process.getuid?.() ?? 'user'}-${hash}`);
  return { home, runtime, profiles: join(home, 'profiles'), artifacts: join(home, 'artifacts') };
}
export async function privateDir(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || (process.getuid && stat.uid !== process.getuid())) fail('UNSAFE_PATH', `Not an owned directory: ${path}`);
  await chmod(path, 0o700);
}
export async function initialize(p) {
  for (const dir of [p.home, p.runtime, p.profiles, p.artifacts]) await privateDir(dir);
}
export function sessionPaths(p, session) {
  const dir = join(p.runtime, name(session, 'Session'));
  return { dir, socket: join(dir, 'rpc.sock'), state: join(dir, 'state.json'), log: join(dir, 'worker.log') };
}
export async function jsonFile(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}
export async function writeJSON(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await rename(temporary, path);
}
export function alive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}
export function chromePath() {
  const chrome = process.env.CHROME_PATH || process.env.PATH?.split(':').map((dir) => join(dir, 'google-chrome')).find(existsSync);
  if (!chrome || !existsSync(chrome)) fail('CHROME_NOT_FOUND', 'Install Google Chrome or set CHROME_PATH to its executable.');
  return chrome;
}
export function rpc(socketPath, request, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let text = '';
    const timer = setTimeout(() => finish(Object.assign(new Error('Browser worker did not respond. Inspect status before retrying a write.'), { code: 'TRANSPORT_TIMEOUT' })), timeoutMs);
    function finish(error, value) {
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error); else resolve(value);
    }
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(JSON.stringify(request) + '\n'));
    socket.on('error', (error) => finish(error));
    socket.on('data', (chunk) => {
      text += chunk;
      if (Buffer.byteLength(text) > MAX_RESULT + 8192) return finish(new Error('Worker response exceeded the output limit.'));
      if (text.includes('\n')) {
        try { finish(null, JSON.parse(text.slice(0, text.indexOf('\n')))); } catch (error) { finish(error); }
      }
    });
    socket.on('end', () => { if (!text.includes('\n')) finish(new Error('Worker closed without a complete response.')); });
  });
}
