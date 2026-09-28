import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { chromePath, paths, sleep } from '../../src/browser-check/shared.mjs';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../../bin/browser-check.mjs', import.meta.url));
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
  const dir = await mkdtemp(join(tmpdir(), 'browser-check-test-'));
  const env = { ...process.env, BROWSER_CHECK_HOME: join(dir, 'state') };
  const http = createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    if (req.url === '/slow') {
      const timer = setTimeout(() => res.end(fixture), 2000);
      res.on('close', () => clearTimeout(timer));
    } else res.end(fixture);
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
test('real browser: layout, interaction, files, errors, traces, profile reuse and timeouts', { timeout: 180_000 }, async (t) => {
  const { dir, env, url, call } = await environment(t);
  const run = (...args) => call([args[0], '--session', 'review', ...args.slice(1)]);
  let result = await call(['open', '--session', 'review', '--profile', 'preview', '--width', '390', '--height', '844', url]);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.status, 'ready');
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
  assert.equal((await run('goto', `${url}/login`)).ok, true);
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
  const missing = await call(['open', '--session', 'missing', '--profile', 'retry', url], { extraEnv: { CHROME_PATH: '/nonexistent/browser-check-chrome' } });
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
  const opened = await call(['open', '--session', 'after-login', '--profile', 'manual', url]);
  assert.equal(opened.ok, true, JSON.stringify(opened));
  const authenticated = await call(['eval', '--session', 'after-login', 'return {cookie:document.cookie, user:localStorage.getItem("fixture_user")};']);
  assert.match(authenticated.value.cookie, /fixture_auth=yes/);
  assert.equal(authenticated.value.user, 'teacher');
});
