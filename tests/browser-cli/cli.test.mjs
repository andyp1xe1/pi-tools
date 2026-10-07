import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { HELP, parse } from '../../src/browser-cli/cli.mjs';
import { paths, name, webURL } from '../../src/browser-cli/shared.mjs';

test('validates sessions, URLs, dimensions and option combinations', () => {
  assert.deepEqual(parse(['version']).positional, []);
  assert.equal(parse(['login', '--profile', 'mentor-preview', 'https://example.org']).options.session, 'mentor-preview');
  assert.equal(parse(['open', '--session', 'review', '--profile', 'preview', 'https://example.org']).options.width, 1440);
  assert.deepEqual(parse(['viewport', '--session', 'review', '390', '844']).positional, [390, 844]);
  assert.deepEqual(parse(['record', '--session', 'review']).positional, []);
  assert.deepEqual(parse(['record', '--session', 'review', 'stop']).positional, ['stop']);
  const recording = parse(['record', '--session', 'proof', '--profile', 'preview', '--width', '390', '--height', '844', 'https://example.org']);
  assert.deepEqual([recording.options.width, recording.options.height, recording.positional[0]], [390, 844, 'https://example.org/']);
  assert.equal(parse(['settle', '--session', 'review']).positional.length, 0);
  for (const args of [
    ['open', '--profile', 'preview', 'https://example.org'],
    ['open', '--session', 'review', '--profile', '../private', 'https://example.org'],
    ['goto', '--session', 'review', 'file:///etc/passwd'],
    ['goto', '--session', 'review', 'https://user:secret@example.org'],
    ['viewport', '--session', 'review', '0', '844'],
    ['click', '--session', 'review', '--role', 'button'],
    ['click', '--session', 'review', '--role', 'button', '--name', 'Go', '#extra'],
    ['click', '--session', 'review', 'button', '--x', '2'],
    ['fill', '--session', 'review', '--text', 'Title'],
    ['eval', '--session', 'review', '--file', 'x.js', 'extra'],
    ['close', '--session', 'review', '--unknown'],
    ['version', '--session', 'review'],
    ['version', 'extra'],
    ['wait', '--session', 'review', '#thing', '--state', 'banana'],
    ['snapshot', '--session', 'review', '--timeout', '-1'],
    ['scroll', '--session', 'review'],
    ['record', '--session', 'proof', '--profile', 'preview', 'https://example.org'],
    ['record', '--session', 'proof', '--profile', 'preview', '--width', '390', '--height', '844', 'stop'],
    ['record', '--session', 'proof', '--width', '390'],
    ['record', '--session', 'proof', 'https://example.org'],
    ['record', '--session', 'proof', 'stop', 'extra'],
    ['settle', '--session', 'proof', 'body', 'extra'],
  ]) assert.throws(() => parse(args), { code: 'INVALID_ARGUMENT' }, args.join(' '));
});

test('renamed help and errors use browser-cli', () => {
  assert.match(HELP, /^browser-cli\. Direct browser inspection/);
  assert.match(HELP, /BROWSER_CLI_HOME/);
  assert.match(HELP, /BROWSER_CLI_REVISION/);
  assert.throws(() => parse(['unknown']), /Run browser-cli help/);
  assert.throws(() => parse(['version', 'extra']), /Run browser-cli help/);
});

test('data home defaults, legacy fallback, precedence and runtime isolation', () => {
  assert.equal(paths({}).home, join(homedir(), '.local/share/browser-cli'));
  assert.equal(paths({ XDG_DATA_HOME: '/tmp/xdg' }).home, '/tmp/xdg/browser-cli');
  const old = paths({ BROWSER_CHECK_HOME: '/tmp/legacy' });
  const current = paths({ BROWSER_CLI_HOME: '/tmp/legacy' });
  assert.deepEqual(old, current);
  assert.equal(current.profiles, '/tmp/legacy/profiles');
  assert.equal(current.artifacts, '/tmp/legacy/artifacts');
  assert.deepEqual(paths({ BROWSER_CLI_HOME: '', BROWSER_CHECK_HOME: '/tmp/legacy' }), old);
  assert.equal(paths({ BROWSER_CLI_HOME: '/tmp/new', BROWSER_CHECK_HOME: '/tmp/legacy', XDG_DATA_HOME: '/tmp/xdg' }).home, '/tmp/new');
  assert.equal(paths({ BROWSER_CLI_HOME: './relative' }).home, resolve('./relative'));
  const hash = createHash('sha256').update(current.home).digest('hex').slice(0, 12);
  assert.equal(current.runtime, join(tmpdir(), `browser-cli-${process.getuid?.() ?? 'user'}-${hash}`));
});

test('literal values, scoped roles, coordinates and bounded names', () => {
  const parsed = parse(['fill', '--session', 'review', '--role', 'textbox', '--name', 'Title', '--', '--not-a-flag']);
  assert.deepEqual(parsed.positional, ['--not-a-flag']);
  assert.equal(parse(['scroll', '--session', 'review', '--y', '-200']).options.y, -200);
  assert.equal(parse(['click', '--session', 'review', '--role', 'button', '--name', 'Edit', '--within', '#card']).options.within, '#card');
  assert.throws(() => name('x'.repeat(49)), { code: 'INVALID_ARGUMENT' });
  assert.equal(webURL('http://localhost:3000'), 'http://localhost:3000/');
  assert.notEqual(paths({ BROWSER_CLI_HOME: '/tmp/a' }).runtime, paths({ BROWSER_CLI_HOME: '/tmp/b' }).runtime);
});
