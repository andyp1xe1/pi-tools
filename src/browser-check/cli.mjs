import { spawn } from 'node:child_process';
import { open, readFile, readdir, mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  alive, errorResult, fail, initialize, integer, jsonFile, MAX_REQUEST,
  name, paths, rpc, sessionPaths, sleep, webURL,
} from './shared.mjs';

export const HELP = `browser-check — direct browser inspection (JSON output)

Login / sessions:
  login --profile NAME [--session NAME] URL   Open ordinary Chrome for manual login
  open --profile NAME --session NAME URL [--headed] [--width 1440 --height 900]
  record --profile NAME --session NAME --width W --height H URL   Open and record MP4
  record --session NAME                     Record the current tab and viewport
  record --session NAME stop                Finish MP4; keep the session open
  settle --session NAME [SELECTOR]          Wait for fonts and stable element bounds
  status --session NAME                      Report browser/login state
  sessions                                   List sessions (including closed ones)
  profiles                                   List saved profiles and their leases
  close --session NAME [--force]              Close automation; --force required for login

Inspection (all require --session NAME):
  snapshot [SELECTOR]                        Accessibility tree (bounded)
  eval CODE | eval --file FILE | eval -      Async page function body; use return
  rect SELECTOR [--all]                      Rectangles, client/scroll sizes
  styles SELECTOR PROPERTY... [--all]        Selected computed CSS properties
  screenshot [FILE] [--full-page]            Save PNG; default private artifact path
  viewport WIDTH HEIGHT
  goto URL
  click [SELECTOR] [--role ROLE --name NAME] [--text TEXT] [--within SELECTOR]
        [--x N --y N]                        Offsets from element padding-box origin
  fill [SELECTOR] VALUE                      Same locator flags as click
  press [SELECTOR] KEY                       Same locator flags; e.g. ControlOrMeta+A
  hover [SELECTOR]                           Same locator flags
  wait [SELECTOR] [--state visible|hidden|attached|detached]
  scroll [SELECTOR] --x N --y N               Scroll by pixels; omit selector for page
  trace start | trace stop [FILE]

Global: --timeout MS (100–120000; default 15000, startup 30000).
Locators must match exactly one element unless --all is explicitly supported.
-- within an argument list ends option parsing. All relative file paths use your cwd.
Environment: CHROME_PATH, BROWSER_CHECK_HOME, XDG_DATA_HOME.
Profiles are full browser credentials. eval is trusted code, NOT read-only.
`;

const COMMON = ['session', 'timeout'];
const TARGET = ['role', 'name', 'text', 'within'];
const OPTIONS = {
  login: ['profile', 'session', 'timeout'],
  open: [...COMMON, 'profile', 'headed', 'width', 'height'],
  record: [...COMMON, 'profile', 'headed', 'width', 'height'],
  settle: COMMON,
  status: ['session'], sessions: [], profiles: [], close: ['session', 'force', 'timeout'],
  snapshot: COMMON, eval: [...COMMON, 'file'], rect: [...COMMON, 'all'], styles: [...COMMON, 'all'],
  screenshot: [...COMMON, 'full-page'], viewport: COMMON, goto: COMMON,
  click: [...COMMON, ...TARGET, 'x', 'y'], fill: [...COMMON, ...TARGET],
  press: [...COMMON, ...TARGET], hover: [...COMMON, ...TARGET],
  wait: [...COMMON, ...TARGET, 'state'], scroll: [...COMMON, 'x', 'y'], trace: COMMON,
};
const BOOLEAN = new Set(['headed', 'force', 'all', 'full-page']);
export function parse(argv) {
  const [command, ...args] = argv;
  if (!command || command === 'help' || command === '--help') return { command: 'help' };
  if (!OPTIONS[command]) fail('INVALID_ARGUMENT', `Unknown command: ${command}. Run browser-check help.`);
  const options = {}, positional = [];
  let literal = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--' && !literal) { literal = true; continue; }
    if (!literal && arg.startsWith('--')) {
      const key = arg.slice(2);
      if (!OPTIONS[command].includes(key)) fail('INVALID_ARGUMENT', `Unknown option for ${command}: ${arg}`);
      if (key in options) fail('INVALID_ARGUMENT', `Repeated option: ${arg}`);
      if (BOOLEAN.has(key)) options[key] = true;
      else {
        const value = args[++i];
        if (value === undefined || value.startsWith('--')) fail('INVALID_ARGUMENT', `${arg} needs a value.`);
        options[key] = value;
      }
    } else positional.push(arg);
  }
  const defaultTimeout = ['close'].includes(command) || (command === 'record' && positional[0] === 'stop') ? 60_000
    : ['open', 'login'].includes(command) || (command === 'record' && options.profile) ? 30_000 : 15_000;
  const timeout = integer(options.timeout, defaultTimeout, 100, 120_000, 'Timeout');
  if (options.profile !== undefined) name(options.profile, 'Profile');
  if (command === 'login') options.session ??= options.profile;
  if (!['sessions', 'profiles'].includes(command)) name(options.session, 'Session');
  const request = { command, options, positional, timeout };
  function count(min, max = min) {
    if (positional.length < min || positional.length > max) fail('INVALID_ARGUMENT', `Invalid arguments for ${command}. Run browser-check help.`);
  }
  if (['open', 'login'].includes(command)) {
    name(options.profile, 'Profile'); count(1); positional[0] = webURL(positional[0]);
    if (command === 'open') {
      options.width = integer(options.width, 1440, 240, 7680, 'Width');
      options.height = integer(options.height, 900, 200, 4320, 'Height');
    }
  } else if (command === 'record') {
    if (options.profile !== undefined) {
      count(1); positional[0] = webURL(positional[0]);
      options.width = integer(options.width, undefined, 240, 7680, 'Width');
      options.height = integer(options.height, undefined, 200, 4320, 'Height');
    } else {
      count(0, 1);
      if (positional[0] !== undefined && positional[0] !== 'stop') fail('INVALID_ARGUMENT', 'Use record --session NAME stop, or supply --profile, --width, --height and URL to open a recording session.');
      if (options.width !== undefined || options.height !== undefined || options.headed) fail('INVALID_ARGUMENT', 'An existing session keeps its viewport. Use viewport before record.');
    }
  } else if (['status', 'sessions', 'profiles', 'close'].includes(command)) count(0);
  else if (command === 'settle') count(0, 1);
  else if (command === 'goto') { count(1); positional[0] = webURL(positional[0]); }
  else if (command === 'viewport') {
    count(2);
    positional[0] = integer(positional[0], undefined, 240, 7680, 'Width');
    positional[1] = integer(positional[1], undefined, 200, 4320, 'Height');
  } else if (command === 'eval') count(options.file ? 0 : 1);
  else if (command === 'rect') count(1);
  else if (command === 'styles') count(2, 40);
  else if (['snapshot', 'screenshot', 'scroll'].includes(command)) count(0, 1);
  else if (command === 'trace') {
    if (!['start', 'stop'].includes(positional[0])) fail('INVALID_ARGUMENT', 'Use trace start or trace stop [FILE].');
    count(1, positional[0] === 'stop' ? 2 : 1);
  } else {
    if ((options.role === undefined) !== (options.name === undefined)) fail('INVALID_ARGUMENT', '--role and --name must be supplied together.');
    if (options.text !== undefined && options.role !== undefined) fail('INVALID_ARGUMENT', 'Choose --text or --role/--name, not both.');
    const named = options.role !== undefined || options.text !== undefined;
    const values = ['fill', 'press'].includes(command) ? 1 : 0;
    count(values + (named ? 0 : 1));
    if (command === 'wait' && options.state && !['visible', 'hidden', 'attached', 'detached'].includes(options.state))
      fail('INVALID_ARGUMENT', 'Wait state must be visible, hidden, attached, or detached.');
  }
  if (command === 'click' && ((options.x === undefined) !== (options.y === undefined))) fail('INVALID_ARGUMENT', 'Click position needs both --x and --y.');
  if (command === 'scroll' && options.x === undefined && options.y === undefined) fail('INVALID_ARGUMENT', 'Scroll needs --x and/or --y.');
  for (const axis of ['x', 'y']) if (options[axis] !== undefined) {
    const n = Number(options[axis]);
    if (!Number.isFinite(n) || Math.abs(n) > 1_000_000 || (command === 'click' && n < 0)) fail('INVALID_ARGUMENT', `Invalid --${axis} coordinate.`);
    options[axis] = n;
  }
  return request;
}

async function stateFor(sp) {
  const state = await jsonFile(sp.state);
  if (!state) return { status: 'starting', log: sp.log };
  if (['ready', 'needs_user', 'starting'].includes(state.status) && !alive(state.pid)) return { ...state, status: 'stale', message: 'Worker is gone. Profile lock may need manual inspection; no process was killed.' };
  return state;
}
async function start(p, request) {
  const sp = sessionPaths(p, request.options.session);
  try { await mkdir(sp.dir, { mode: 0o700 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    fail('SESSION_EXISTS', `Session ${request.options.session} already exists. Inspect status and close it before reusing its name.`);
  }
  const log = await open(sp.log, 'a', 0o600);
  let child;
  try {
    child = spawn(process.execPath, [fileURLToPath(new URL('./worker.mjs', import.meta.url))], {
      detached: true, stdio: ['pipe', log.fd, log.fd], env: process.env,
    });
    await new Promise((done, reject) => { child.once('spawn', done); child.once('error', reject); });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(request));
    child.unref();
  } catch (error) { await rm(sp.dir, { recursive: true, force: true }); throw error; }
  finally { await log.close(); }
  const until = Date.now() + request.timeout + 10_000;
  while (Date.now() < until) {
    const state = await jsonFile(sp.state);
    if (state && state.status !== 'starting') {
      if (state.status === 'failed') return { ok: false, error: state.error, session: request.options.session, log: sp.log };
      return { ok: true, ...state };
    }
    if (!alive(child.pid)) fail('START_FAILED', `Worker exited during startup. Inspect ${sp.log}`);
    await sleep(50);
  }
  fail('START_TIMEOUT', `Startup did not respond. Inspect ${sp.log} and status before retrying.`);
}

async function readStdin() {
  let source = '';
  for await (const chunk of process.stdin) {
    source += chunk;
    if (Buffer.byteLength(source) > MAX_REQUEST) fail('INPUT_TOO_LARGE', 'Script exceeds 256 KiB.');
  }
  return source;
}

export async function main(argv = process.argv.slice(2)) {
  process.umask(0o077);
  try {
    const request = parse(argv);
    if (request.command === 'help') { console.log(HELP); return; }
    const p = paths();
    await initialize(p);
    if (request.command === 'eval') {
      const source = request.options.file ? await readFile(resolve(request.options.file), 'utf8')
        : request.positional[0] === '-' ? await readStdin() : request.positional[0];
      request.code = source;
    }
    if (request.command === 'screenshot' && request.positional[0]) request.positional[0] = resolve(request.positional[0]);
    if (request.command === 'trace' && request.positional[1]) request.positional[1] = resolve(request.positional[1]);
    if (Buffer.byteLength(JSON.stringify(request)) > MAX_REQUEST) fail('INPUT_TOO_LARGE', 'Command exceeds 256 KiB. Use a smaller script.');
    let response;
    if (['login', 'open'].includes(request.command) || (request.command === 'record' && request.options.profile)) response = await start(p, request);
    else if (request.command === 'sessions') {
      const entries = await readdir(p.runtime, { withFileTypes: true });
      response = { ok: true, sessions: await Promise.all(entries.filter((e) => e.isDirectory()).map((e) => stateFor(sessionPaths(p, e.name)))) };
    } else if (request.command === 'profiles') {
      const entries = await readdir(p.profiles, { withFileTypes: true });
      response = { ok: true, profiles: await Promise.all(entries.filter((e) => e.isDirectory()).map(async (e) => ({ profile: e.name, lease: await jsonFile(resolve(p.profiles, e.name, 'lease/owner.json')) }))) };
    } else {
      const sp = sessionPaths(p, request.options.session);
      const state = await jsonFile(sp.state);
      if (!state) fail('SESSION_NOT_FOUND', `No initialized session named ${request.options.session}.`);
      if (request.command === 'status') response = { ok: true, ...await stateFor(sp) };
      else if (request.command === 'close' && !alive(state.pid)) {
        // Never remove a profile lease here: a crashed worker may have left Chrome running.
        await rm(sp.dir, { recursive: true, force: true });
        response = { ok: true, status: 'closed', session: request.options.session, message: 'Removed stopped session metadata. Any stale profile lease was preserved for inspection.' };
      } else {
        response = await rpc(sp.socket, request, request.timeout + 10_000);
        if (request.command === 'close' && response.ok) {
          for (let i = 0; i < 100 && alive(state.pid); i++) await sleep(50);
          if (!alive(state.pid)) await rm(sp.dir, { recursive: true, force: true });
        }
      }
    }
    console.log(JSON.stringify(response));
    if (!response.ok) process.exitCode = 1;
  } catch (error) {
    console.log(JSON.stringify(errorResult(error)));
    process.exitCode = 1;
  }
}
