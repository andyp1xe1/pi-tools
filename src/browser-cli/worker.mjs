import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { appendFile, chmod, mkdir, readlink, rm } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { operate } from './browser.mjs';
import { startVideo } from './video.mjs';
import {
  alive, chromePath, errorResult, fail, integer, jsonFile, MAX_REQUEST, MAX_RESULT,
  paths, privateDir, sessionPaths, sleep, writeJSON,
} from './shared.mjs';

process.umask(0o077);
let input = '';
for await (const chunk of process.stdin) {
  input += chunk;
  if (Buffer.byteLength(input) > MAX_REQUEST) throw new Error('Startup request too large.');
}
const request = JSON.parse(input);
const p = paths();
const { profile, session } = request.options;
const sp = sessionPaths(p, session);
const profileDir = join(p.profiles, profile);
const leaseDir = join(profileDir, 'lease');
const chromeProfile = join(profileDir, 'chrome');
const startedAt = new Date().toISOString();
const runDir = join(p.artifacts, `${startedAt.replace(/[:.]/g, '-')}-${session}`);
let state = { session, profile, pid: process.pid, mode: request.command === 'login' ? 'login' : 'automation', status: 'starting', startedAt, startURL: request.positional[0], artifacts: runDir };
let context, page, login, loginExit, browser, server;
let leased = false, busy = false, stopping = false, initialized = false;
let stopPromise, launchWork;

async function update(values) {
  state = { ...state, ...values, updatedAt: new Date().toISOString() };
  await writeJSON(sp.state, state);
}
async function stop(status = 'closed', error) {
  if (stopPromise) return stopPromise;
  stopping = true;
  stopPromise = (async () => {
    // If browser teardown hangs, leave the lease rather than pretending it is safe to reuse.
    const hardStop = setTimeout(() => process.exit(1), browser?.video ? 60_000 : 8000);
    try {
      let videoError;
      // Never release a profile while a timed-out launch could still create a browser.
      if (!initialized && launchWork) await launchWork.catch(() => {});
      if (context) {
        if (browser?.video) {
          try { state.video = await browser.video.stop(); }
          catch (error) { videoError = error; }
        }
        if (browser?.tracing) await context.tracing.stop({ path: join(runDir, 'closing-trace.zip') }).catch(() => {});
        await context.close();
      }
      if (login && login.exitCode === null && login.signalCode === null) {
        login.kill('SIGTERM');
        await loginExit;
      }
      if (leased) {
        const owner = await jsonFile(join(leaseDir, 'owner.json'));
        if (owner?.pid === process.pid) await rm(leaseDir, { recursive: true, force: true });
        leased = false;
      }
      await update({ status: videoError ? 'failed' : status, ...((videoError || error) ? { error: errorResult(videoError || error).error } : {}) });
      server?.close();
    } catch (cleanupError) {
      await update({ status: 'failed', error: errorResult(cleanupError).error }).catch(() => {});
      server?.close();
    } finally { clearTimeout(hardStop); }
  })();
  return stopPromise;
}
function deadline(work, ms) {
  let timer;
  return Promise.race([
    work,
    new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('Command timed out; this session is being closed to prevent a late action. Open a new session after checking status.'), { code: 'COMMAND_TIMEOUT' })), ms); }),
  ]).finally(() => clearTimeout(timer));
}
async function dispatch(command) {
  if (stopping) fail('SESSION_CLOSING', 'Session is closing.');
  if (command.command === 'close') {
    if (state.mode === 'login' && !command.options.force) fail('NEEDS_USER', 'Close the login window yourself, or explicitly pass --force to terminate it.');
    await stop();
    if (state.status === 'failed') fail('CLOSE_FAILED', state.error?.message || 'Session teardown failed.');
    return { ...(state.video ? { video: state.video } : {}) };
  }
  if (state.mode === 'login') fail('NEEDS_USER', 'This is a manual login window. Sign in, close it, then open an automation session using the profile.');
  const result = await operate(browser, command);
  await update({ url: page.url(), viewport: page.viewportSize(),
    ...(command.command === 'record' ? { recording: Boolean(browser.video), ...(result.video ? { video: result.video } : {}) } : {}),
  });
  return result;
}
function listen() {
  server = createServer((socket) => {
    let buffer = '', received = false;
    socket.setEncoding('utf8');
    socket.setTimeout(130_000, () => socket.destroy());
    socket.on('error', () => {});
    const send = (value) => {
      let json = JSON.stringify(value);
      if (Buffer.byteLength(json) > MAX_RESULT) json = JSON.stringify(errorResult(Object.assign(new Error('Result exceeded 64 KiB. The operation already ran; narrow your query before retrying.'), { code: 'OUTPUT_TOO_LARGE' })));
      socket.end(json + '\n');
    };
    socket.on('data', async (chunk) => {
      if (received) return;
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_REQUEST) { received = true; send(errorResult(new Error('Request exceeded 256 KiB.'))); return; }
      if (!buffer.includes('\n')) return;
      received = true;
      if (busy) { send(errorResult(Object.assign(new Error('Another command is running in this session. Wait for it to finish.'), { code: 'SESSION_BUSY' }))); return; }
      busy = true;
      let command;
      try {
        command = JSON.parse(buffer.slice(0, buffer.indexOf('\n')));
        if (command.options?.session !== session) fail('INVALID_ARGUMENT', 'Session mismatch.');
        const timeout = integer(command.timeout, 15_000, 100, 120_000, 'Timeout');
        const result = await deadline(dispatch(command), timeout);
        await appendFile(join(runDir, 'commands.jsonl'), JSON.stringify({ command: command.command, at: new Date().toISOString(), ok: true }) + '\n', { mode: 0o600 });
        send({ ok: true, session, url: page?.url(), ...result });
      } catch (error) {
        // Playwright action timeouts also terminate the session: no uncertain late actions.
        if (error.code === 'COMMAND_TIMEOUT' || error.name === 'TimeoutError') await stop('failed', error);
        send(errorResult(error));
      } finally { busy = false; }
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(sp.socket, async () => {
      try { await chmod(sp.socket, 0o600); resolve(); } catch (error) { reject(error); }
    });
  });
}

async function launch() {
  await privateDir(profileDir);
  try { await mkdir(leaseDir, { mode: 0o700 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    fail('PROFILE_BUSY', `Profile ${profile} is locked. Close its browser session first. If its worker crashed, inspect ${leaseDir}; locks are never stolen automatically.`);
  }
  leased = true;
  await writeJSON(join(leaseDir, 'owner.json'), { pid: process.pid, session, mode: state.mode, startedAt });
  await privateDir(chromeProfile);
  try {
    const lock = await readlink(join(chromeProfile, 'SingletonLock'));
    const match = lock.match(/^(.*)-(\d+)$/);
    if (!match || match[1] !== hostname() || alive(Number(match[2])))
      fail('PROFILE_BUSY', 'Chrome already owns this profile. Close that browser; do not remove locks while Chrome is running.');
    // Chrome itself recovers its stale same-host lock. We never delete Chromium locks.
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const chrome = chromePath();
  if (state.mode === 'login') {
    if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) fail('NO_DISPLAY', 'Manual login needs a graphical desktop on this machine.');
    login = spawn(chrome, [
      `--user-data-dir=${chromeProfile}`, '--no-first-run', '--no-default-browser-check',
      '--new-window', request.positional[0],
    ], { stdio: ['ignore', 'inherit', 'inherit'] });
    loginExit = new Promise((resolve) => login.once('exit', (code, signal) => resolve({ code, signal })));
    await new Promise((resolve, reject) => { login.once('spawn', resolve); login.once('error', reject); });
    await writeJSON(join(leaseDir, 'owner.json'), { pid: process.pid, browserPid: login.pid, session, mode: 'login', startedAt });
    // Catch immediate launch failures rather than announcing a window that never opened.
    await sleep(350);
    if (stopping) { login.kill('SIGTERM'); return; }
    if (login.exitCode !== null || login.signalCode !== null) fail('LOGIN_EXITED', `Chrome exited before login was ready (code ${login.exitCode}). Inspect ${sp.log}.`);
    await listen();
    await update({ status: 'needs_user', browserPid: login.pid, message: 'Sign in in the browser window, then close all windows for this profile. Tell the agent when you are done.' });
    initialized = true;
    void loginExit.then(async ({ code, signal }) => {
      if (!stopping) await stop(code === 0 ? 'closed' : 'failed', code === 0 ? undefined : new Error(`Login browser exited with code ${code}, signal ${signal}.`));
    });
  } else {
    context = await chromium.launchPersistentContext(chromeProfile, {
      executablePath: chrome, headless: !request.options.headed, chromiumSandbox: true,
      // Match ordinary login Chrome's OS credential storage. Playwright's basic-store
      // defaults can make cookies encrypted during manual login unreadable on reuse.
      ignoreDefaultArgs: ['--password-store=basic', '--use-mock-keychain'],
      viewport: { width: request.options.width, height: request.options.height },
      timeout: request.timeout,
    });
    if (stopping) { await context.close(); return; }
    page = context.pages()[0] || await context.newPage();
    // v1 controls exactly one tab. Popups are explicitly unsupported, not silently targeted.
    context.on('page', (opened) => { if (opened !== page) void opened.close().catch(() => {}); });
    browser = { context, page, runDir, tracing: false };
    page.setDefaultNavigationTimeout(request.timeout);
    await page.goto(request.positional[0], { waitUntil: 'domcontentloaded' });
    if (stopping) return;
    if (request.command === 'record') await startVideo(browser);
    await listen();
    await update({ status: 'open', url: page.url(), viewport: page.viewportSize(), recording: Boolean(browser.video) });
    initialized = true;
    context.on('close', () => { if (!stopping) void stop(); });
  }
}

process.on('SIGTERM', () => { void stop().then(() => process.exit(0)); });
process.on('SIGINT', () => { void stop().then(() => process.exit(0)); });
process.on('uncaughtException', (error) => { console.error(error); void stop('failed', error).then(() => process.exit(1)); });
process.on('unhandledRejection', (error) => { console.error(error); void stop('failed', error).then(() => process.exit(1)); });
try {
  await privateDir(runDir);
  await update({});
  launchWork = launch();
  await deadline(launchWork, request.timeout);
} catch (error) {
  console.error(error);
  await stop('failed', error);
  // A late-resolving browser launch sees stopping and closes itself. Do not keep a failed worker alive indefinitely.
  const exit = setTimeout(() => process.exit(1), 8000);
  exit.unref();
  process.exitCode = 1;
}
