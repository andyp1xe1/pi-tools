import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { chromePath, paths, sleep } from '../../src/browser-cli/shared.mjs';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../../bin/browser-cli.mjs', import.meta.url));
const fixture = `<!doctype html><html><head><style>
body { margin: 0; font-family: sans-serif }
#row { display:flex; gap:16px; padding:12px }
.card { width:100px; height:60px; flex-shrink:0 }
#clip { width:100px; height:60px; overflow:hidden }
#wide { width:180px; height:40px }
#scroll { height:80px; width:120px; overflow:auto }
#scroll > div { height:500px; width:300px }
#editor { display:block; box-sizing:border-box; width:300px; height:180px }
</style></head><body>
<h1>Layout fixture</h1>
<div id="row"><div id="a" class="card"><button>Edit</button></div><div id="b" class="card"><button>Edit</button></div></div>
<div id="clip"><div id="wide">Clipped content</div></div>
<div id="scroll"><div>Scrollable content</div></div>
<label for="editor">Writing</label><textarea id="editor"></textarea>
<button id="toggle" onclick="document.querySelector('#late').hidden=false">Show</button>
<p id="late" hidden>Now visible</p>
<script>
for (const button of document.querySelectorAll('.card button')) button.onclick=()=>document.body.dataset.clicked=button.parentElement.id;
if(location.pathname==='/login') { document.cookie='fixture_auth=yes; Max-Age=3600; SameSite=Lax; path=/'; localStorage.setItem('fixture_user','teacher'); }
</script></body></html>`;

async function environment(t) {
  const dir = await mkdtemp(join(tmpdir(), 'browser-cli-test-'));
  const env = { ...process.env, BROWSER_CLI_HOME: join(dir, 'state') };
  const http = createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    if (req.url === '/slow') {
      const timer = setTimeout(() => res.end(fixture), 2000);
      res.on('close', () => clearTimeout(timer));
    } else if (req.url === '/app-delay') res.end('<main style="height:200px">Loading <span id="ready" hidden>Data ready</span></main><script>setTimeout(()=>{document.querySelector("#ready").hidden=false},3500)</script>');
    else res.end(fixture);
  });
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${http.address().port}`;
  async function call(args, { input, extraEnv = {} } = {}) {
    if (input !== undefined) return await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [cli, ...args], { env: { ...env, ...extraEnv }, stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '', err = '';
      child.stdout.on('data', (chunk) => out += chunk);
      child.stderr.on('data', (chunk) => err += chunk);
      child.on('error', reject);
      child.on('close', (code) => {
        try { resolve({ ...JSON.parse(out), exit: code }); } catch { reject(new Error(out + err)); }
      });
      child.stdin.end(input);
    });
    try {
      const { stdout } = await exec(process.execPath, [cli, ...args], { env: { ...env, ...extraEnv }, timeout: 45_000 });
      return { ...JSON.parse(stdout), exit: 0 };
    } catch (error) {
      if (error.stdout) return { ...JSON.parse(error.stdout), exit: error.code };
      throw error;
    }
  }
  t.after(async () => {
    const list = await call(['sessions']).catch(() => null);
    for (const session of list?.sessions || []) if (session.session) await call(['close', '--session', session.session, '--force']).catch(() => {});
    http.closeAllConnections();
    await new Promise((resolve) => http.close(resolve));
    await rm(paths(env).runtime, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  });
  return { dir, env, url, call };
}

// These launch only isolated local fixture browsers, never personal profiles or live apps.
test('version reports revision and checks FFmpeg without creating session directories', { timeout: 30_000 }, async (t) => {
  const { env, call } = await environment(t);
  const version = await call(['version'], { extraEnv: { BROWSER_CLI_REVISION: 'test-revision' } });
  assert.equal(version.revision, 'test-revision');
  assert.equal(version.ffmpeg.available, true);
  assert.equal(version.version, '0.0.1');
  const legacy = await call(['version'], { extraEnv: { BROWSER_CLI_REVISION: '', BROWSER_CHECK_REVISION: 'legacy-revision' } });
  assert.equal(legacy.revision, 'legacy-revision');
  const preferred = await call(['version'], { extraEnv: { BROWSER_CLI_REVISION: 'current-revision', BROWSER_CHECK_REVISION: 'legacy-revision' } });
  assert.equal(preferred.revision, 'current-revision');
  const missing = await call(['version'], { extraEnv: { FFMPEG_PATH: '/missing/browser-cli-ffmpeg' } });
  assert.equal(missing.ffmpeg.available, false);
  assert.equal(missing.ffmpeg.executable, '/missing/browser-cli-ffmpeg');
  await assert.rejects(stat(env.BROWSER_CLI_HOME), { code: 'ENOENT' });
});

test('legacy data-home override preserves shared profile leases across runtime namespaces', { timeout: 30_000 }, async (t) => {
  const { env, url, call } = await environment(t);
  // The old binary stores its lease in the profile, not its browser-check runtime directory.
  // Model an existing legacy worker without starting or signaling any external process.
  const lease = join(paths(env).profiles, 'legacy', 'lease');
  await mkdir(lease, { recursive: true, mode: 0o700 });
  const owner = JSON.stringify({ pid: process.pid, session: 'old-session', mode: 'automation' });
  await writeFile(join(lease, 'owner.json'), owner, { mode: 0o600 });
  const extraEnv = { BROWSER_CLI_HOME: '', BROWSER_CHECK_HOME: env.BROWSER_CLI_HOME };
  const profiles = await call(['profiles'], { extraEnv });
  assert.equal(profiles.profiles[0].lease.session, 'old-session');
  const refused = await call(['open', '--session', 'conflict', '--profile', 'legacy', url], { extraEnv });
  assert.equal(refused.error.code, 'PROFILE_BUSY', JSON.stringify(refused));
  assert.equal(await readFile(join(lease, 'owner.json'), 'utf8'), owner);
  assert.equal((await call(['close', '--session', 'conflict'])).removed, true);
  assert.equal(await readFile(join(lease, 'owner.json'), 'utf8'), owner);
});

test('MP4 recording from a new or existing session, preserving viewport and page state', { timeout: 120_000 }, async (t) => {
  const { url, call } = await environment(t);
  const fresh = await call(['record', '--session', 'fresh', '--profile', 'video', '--width', '391', '--height', '845', url]);
  assert.equal(fresh.ok, true, JSON.stringify(fresh));
  assert.deepEqual(fresh.viewport, { width: 391, height: 845 });
  assert.equal(fresh.recording, true);
  assert.equal(fresh.status, 'open');
  assert.equal(fresh.navigationWaitedFor, 'domcontentloaded');
  assert.equal((await call(['click', '--session', 'fresh', '#toggle'])).ok, true);
  await sleep(400);
  assert.equal((await call(['record', '--session', 'fresh'])).error.code, 'VIDEO_ACTIVE');
  const first = await call(['record', '--session', 'fresh', 'stop']);
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.recording, false);
  assert.equal(first.video.format, 'mp4');
  assert.equal(first.video.codec, 'h264');
  assert.equal(first.video.fps, 10);
  assert.deepEqual([first.video.width, first.video.height], [390, 844]);
  const encoded = JSON.parse((await exec('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', first.video.path])).stdout);
  assert.deepEqual([encoded.streams[0].width, encoded.streams[0].height], [first.video.width, first.video.height]);
  assert.equal(first.video.bytes, (await stat(first.video.path)).size);
  assert.ok(first.video.durationSeconds >= 0.4);
  assert.equal((await readFile(first.video.path)).subarray(4, 8).toString(), 'ftyp');
  assert.equal((await stat(first.video.path)).mode & 0o777, 0o600);
  assert.equal((await call(['record', '--session', 'fresh', 'stop'])).error.code, 'NO_VIDEO');
  const finished = await call(['close', '--session', 'fresh']);
  assert.equal(finished.removed, true);
  assert.deepEqual(finished.video, first.video);
  assert.equal((await call(['status', '--session', 'fresh'])).error.code, 'SESSION_NOT_FOUND');
  assert.equal((await call(['sessions'])).sessions.length, 0);

  assert.equal((await call(['open', '--session', 'existing', '--profile', 'video', url])).ok, true);
  assert.equal((await call(['click', '--session', 'existing', '#toggle'])).ok, true);
  assert.equal((await call(['viewport', '--session', 'existing', '500', '360'])).ok, true);
  const ongoing = await call(['record', '--session', 'existing']);
  assert.equal(ongoing.ok, true, JSON.stringify(ongoing));
  assert.deepEqual(ongoing.viewport, { width: 500, height: 360 });
  assert.equal((await call(['viewport', '--session', 'existing', '600', '400'])).error.code, 'VIDEO_ACTIVE');
  assert.equal((await call(['eval', '--session', 'existing', 'return !document.querySelector("#late").hidden'])).value, true);
  await sleep(400);
  const second = await call(['record', '--session', 'existing', 'stop']);
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal((await readFile(second.video.path)).subarray(4, 8).toString(), 'ftyp');
  const probe = await exec('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,width,height', '-show_entries', 'format=duration', '-of', 'json', second.video.path]);
  const media = JSON.parse(probe.stdout);
  assert.equal(media.streams[0].codec_name, 'h264');
  assert.deepEqual([media.streams[0].width, media.streams[0].height], [500, 360]);
  assert.ok(Number(media.format.duration) >= 0.4, media.format.duration);
  assert.equal((await call(['record', '--session', 'existing'])).ok, true);
  await sleep(250);
  const closed = await call(['close', '--session', 'existing']);
  assert.equal(closed.ok, true, JSON.stringify(closed));
  assert.equal(closed.removed, true);
  assert.equal(closed.video.bytes, (await stat(closed.video.path)).size);
  assert.equal((await readFile(closed.video.path)).subarray(4, 8).toString(), 'ftyp');
  assert.equal((await call(['sessions'])).sessions.length, 0);
  assert.match((await call(['sessions'])).message, /close removes records/);
  assert.equal((await call(['profiles'])).profiles.find((profile) => profile.profile === 'video').lease, null);
});

test('missing FFmpeg reports a clear failure without stealing the profile', { timeout: 60_000 }, async (t) => {
  const { url, call } = await environment(t);
  const unavailable = { FFMPEG_PATH: '/missing/browser-cli-ffmpeg' };
  const failed = await call(['record', '--session', 'new-failure', '--profile', 'preview', '--width', '390', '--height', '844', url], { extraEnv: unavailable });
  assert.equal(failed.error.code, 'FFMPEG_UNAVAILABLE');
  assert.equal((await call(['profiles'])).profiles.find((profile) => profile.profile === 'preview').lease, null);
  assert.equal((await call(['open', '--session', 'existing-failure', '--profile', 'preview', url], { extraEnv: unavailable })).ok, true);
  const midSession = await call(['record', '--session', 'existing-failure']);
  assert.equal(midSession.error.code, 'FFMPEG_UNAVAILABLE');
  assert.equal((await call(['eval', '--session', 'existing-failure', 'return document.title'])).ok, true);
  assert.equal((await call(['close', '--session', 'existing-failure'])).ok, true);
});

test('settle waits for fonts and stable geometry without hiding app readiness', { timeout: 60_000 }, async (t) => {
  const { url, call } = await environment(t);
  assert.equal((await call(['open', '--session', 'layout', '--profile', 'settle', url])).ok, true);
  const outcome = await call(['settle', '--session', 'layout', '#editor']);
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  assert.equal(outcome.rect.width, 300);
  assert.equal(outcome.stableForMs, 200);
  assert.equal(outcome.selector, '#editor');
  assert.equal(outcome.geometryOnly, true);
  assert.equal((await call(['close', '--session', 'layout'])).ok, true);
});

test('open only waits for navigation; wait for app data before settling geometry', { timeout: 60_000 }, async (t) => {
  const { url, call } = await environment(t);
  const opened = await call(['open', '--session', 'loading', '--profile', 'preview', `${url}/app-delay`]);
  assert.equal(opened.status, 'open');
  assert.equal(opened.navigationWaitedFor, 'domcontentloaded');
  const geometry = await call(['settle', '--session', 'loading', 'main']);
  assert.equal(geometry.geometryOnly, true);
  assert.equal((await call(['eval', '--session', 'loading', 'return document.querySelector("#ready").hidden'])).value, true);
  assert.equal((await call(['wait', '--session', 'loading', '#ready'])).state, 'visible');
  assert.equal((await call(['settle', '--session', 'loading', '#ready'])).selector, '#ready');
  assert.equal((await call(['close', '--session', 'loading'])).removed, true);
});

test('real browser: layout, interaction, files, errors, traces, profile reuse and timeouts', { timeout: 180_000 }, async (t) => {
  const { dir, env, url, call } = await environment(t);
  const run = (...args) => call([args[0], '--session', 'review', ...args.slice(1)]);
  let result = await call(['open', '--session', 'review', '--profile', 'preview', '--width', '390', '--height', '844', url]);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.status, 'open');
  assert.equal(result.navigationWaitedFor, 'domcontentloaded');
  assert.deepEqual(result.viewport, { width: 390, height: 844 });
  assert.equal((await stat(paths(env).home)).mode & 0o777, 0o700);
  assert.match((await run('snapshot')).tree, /Layout fixture/);
  const geometry = await run('rect', '#clip');
  assert.equal(geometry.elements[0].client.width, 100);
  assert.equal(geometry.elements[0].scroll.width, 180);
  assert.equal(geometry.elements[0].overflow.x, 'hidden');
  assert.equal((await run('styles', '#row', 'gap')).elements[0].gap, '16px');
  assert.equal((await run('rect', '.card', '--all')).elements.length, 2);
  assert.equal((await run('eval', 'const a=document.querySelector("#a").getBoundingClientRect(); const b=document.querySelector("#b").getBoundingClientRect(); return b.left-a.right;')).value, 16);
  assert.equal((await run('eval', 'return typeof process;')).value, 'undefined');
  assert.equal((await run('eval', 'return await Promise.resolve(42);')).value, 42);
  assert.equal((await run('eval', 'throw new Error("fixture failure")')).ok, false);
  assert.equal((await run('eval', 'return "x".repeat(100000)')).ok, false);
  assert.equal((await run('click', '--role', 'button', '--name', 'Edit')).error.code, 'AMBIGUOUS_LOCATOR');
  assert.equal((await run('click', '--role', 'button', '--name', 'Edit', '--within', '#b')).ok, true);
  assert.equal((await run('eval', 'return document.body.dataset.clicked')).value, 'b');
  assert.equal((await run('click', '#editor', '--x', '20', '--y', '165')).ok, true);
  assert.equal((await run('eval', 'return document.activeElement.id')).value, 'editor');
  assert.equal((await run('fill', '--role', 'textbox', '--name', 'Writing', 'hello')).ok, true);
  assert.equal((await run('press', '#editor', 'End')).ok, true);
  assert.equal((await run('press', '#editor', '!')).ok, true);
  assert.equal((await run('eval', 'return document.querySelector("#editor").value')).value, 'hello!');
  assert.equal((await run('hover', '#a')).ok, true);
  assert.equal((await run('click', '#toggle')).ok, true);
  assert.equal((await run('wait', '--text', 'Now visible')).ok, true);
  assert.equal((await run('wait', '#absent', '--state', 'hidden')).ok, true);
  assert.equal((await run('scroll', '#scroll', '--y', '60')).position.y, 60);
  assert.equal((await run('viewport', '768', '900')).viewport.width, 768);
  assert.equal((await run('eval', 'return window.innerWidth')).value, 768);
  const script = join(dir, 'check.js');
  await writeFile(script, 'await document.fonts.ready; return 123;');
  assert.equal((await run('eval', '--file', script)).value, 123);
  assert.equal((await call(['eval', '--session', 'review', '-'], { input: 'return 456;' })).value, 456);
  const screenshot = await run('screenshot');
  assert.equal((await readFile(screenshot.path)).subarray(1, 4).toString(), 'PNG');
  assert.equal((await stat(screenshot.path)).mode & 0o777, 0o600);
  assert.equal((await run('screenshot', screenshot.path)).error.code, 'EEXIST');
  assert.equal((await run('trace', 'start')).ok, true);
  await run('eval', 'return document.title');
  const trace = await run('trace', 'stop');
  assert.equal((await readFile(trace.path)).subarray(0, 2).toString(), 'PK');
  assert.equal((await run('goto', `${url}/login`)).navigationWaitedFor, 'domcontentloaded');
  await run('wait', 'body');
  assert.equal((await run('eval', 'return localStorage.getItem("fixture_user")')).value, 'teacher');
  assert.equal((await call(['open', '--session', 'other', '--profile', 'preview', url])).error.code, 'PROFILE_BUSY');
  assert.equal((await call(['open', '--session', 'review', '--profile', 'separate', url])).error.code, 'SESSION_EXISTS');
  assert.equal((await run('close')).ok, true);
  result = await call(['open', '--session', 'reused', '--profile', 'preview', url]);
  assert.equal(result.ok, true, JSON.stringify(result));
  result = await call(['eval', '--session', 'reused', 'return {cookie:document.cookie, user:localStorage.getItem("fixture_user")};']);
  assert.match(result.value.cookie, /fixture_auth=yes/);
  assert.equal(result.value.user, 'teacher');
  assert.equal((await call(['open', '--session', 'independent', '--profile', 'independent', '--width', '500', url])).ok, true);
  assert.equal((await call(['eval', '--session', 'independent', 'return document.cookie;'])).value, '');
  const long = call(['eval', '--session', 'reused', 'await new Promise(r=>setTimeout(r,1200)); return 1;']);
  await sleep(300);
  assert.equal((await call(['eval', '--session', 'reused', 'return 2;'])).error.code, 'SESSION_BUSY');
  assert.equal((await long).value, 1);
  result = await call(['eval', '--session', 'reused', '--timeout', '200', 'await new Promise(()=>{});']);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'COMMAND_TIMEOUT');
  assert.equal((await call(['status', '--session', 'reused'])).status, 'failed');
  assert.equal((await call(['profiles'])).profiles.find(p => p.profile === 'preview').lease, null);
  assert.equal((await call(['eval', '--session', 'independent', 'return innerWidth;'])).value, 500);
});

test('startup failures release leases and simultaneous session creation has one owner', { timeout: 120_000 }, async (t) => {
  const { url, call } = await environment(t);
  const missing = await call(['open', '--session', 'missing', '--profile', 'retry', url], { extraEnv: { CHROME_PATH: '/nonexistent/browser-cli-chrome' } });
  assert.equal(missing.error.code, 'CHROME_NOT_FOUND');
  assert.equal((await call(['profiles'])).profiles.find(p => p.profile === 'retry').lease, null);
  const slow = await call(['open', '--session', 'slow', '--profile', 'retry', '--timeout', '300', `${url}/slow`]);
  assert.equal(slow.ok, false);
  assert.equal((await call(['profiles'])).profiles.find(p => p.profile === 'retry').lease, null);
  const simultaneous = await Promise.all([
    call(['open', '--session', 'winner', '--profile', 'retry', url]),
    call(['open', '--session', 'winner', '--profile', 'other', url]),
  ]);
  assert.equal(simultaneous.filter(r => r.ok).length, 1, JSON.stringify(simultaneous));
  assert.equal(simultaneous.find(r => !r.ok).error.code, 'SESSION_EXISTS');
  assert.equal((await call(['close', '--session', 'winner'])).ok, true);
});

test('ordinary Chrome login handoff, exclusive profile ownership and cookie reuse', { timeout: 120_000 }, async (t) => {
  const { dir, env, url, call } = await environment(t);
  // Headless/debugging are test-only. CDP lets the fixture simulate a graceful user
  // window close, instead of SIGTERM (which can lose recently written cookies).
  const wrapper = join(dir, 'chrome-for-test');
  await writeFile(wrapper, '#!/usr/bin/env bash\nexec "$REAL_CHROME" --headless=new --remote-debugging-port=0 "$@"\n');
  await chmod(wrapper, 0o700);
  const login = await call(['login', '--profile', 'manual', `${url}/login`], { extraEnv: { CHROME_PATH: wrapper, REAL_CHROME: chromePath(), DISPLAY: process.env.DISPLAY || ':test' } });
  assert.equal(login.ok, true, JSON.stringify(login));
  assert.equal(login.status, 'needs_user');
  assert.equal((await call(['eval', '--session', 'manual', 'return 1'])).error.code, 'NEEDS_USER');
  assert.equal((await call(['close', '--session', 'manual'])).error.code, 'NEEDS_USER');
  assert.equal((await call(['open', '--session', 'conflict', '--profile', 'manual', url])).error.code, 'PROFILE_BUSY');
  const portFile = join(paths(env).profiles, 'manual/chrome/DevToolsActivePort');
  let port;
  for (let i = 0; i < 100; i++) {
    try { port = (await readFile(portFile, 'utf8')).split('\n')[0]; break; } catch { await sleep(50); }
  }
  assert.ok(port, 'Test login Chrome should expose its test-only CDP endpoint');
  const testBrowser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const loginPage = testBrowser.contexts()[0].pages()[0];
  await loginPage.waitForFunction(() => localStorage.getItem('fixture_user') === 'teacher');
  assert.match(await loginPage.evaluate(() => document.cookie), /fixture_auth=yes/);
  const control = await testBrowser.newBrowserCDPSession();
  await control.send('Browser.close');
  await testBrowser.close().catch(() => {});
  let status;
  for (let i = 0; i < 100; i++) {
    status = await call(['status', '--session', 'manual']);
    if (status.status === 'closed') break;
    await sleep(50);
  }
  assert.equal(status.status, 'closed', JSON.stringify(status));
  const removed = await call(['close', '--session', 'manual']);
  assert.equal(removed.removed, true);
  assert.equal((await call(['status', '--session', 'manual'])).error.code, 'SESSION_NOT_FOUND');
  const opened = await call(['open', '--session', 'after-login', '--profile', 'manual', url]);
  assert.equal(opened.ok, true, JSON.stringify(opened));
  const authenticated = await call(['eval', '--session', 'after-login', 'return {cookie:document.cookie, user:localStorage.getItem("fixture_user")};']);
  assert.match(authenticated.value.cookie, /fixture_auth=yes/);
  assert.equal(authenticated.value.user, 'teacher');
});
