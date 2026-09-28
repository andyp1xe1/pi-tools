import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parse } from '../../src/browser-check/cli.mjs';
import { paths, name, webURL } from '../../src/browser-check/shared.mjs';

test('validates sessions, URLs, dimensions and option combinations', () => {
  assert.equal(parse(['login', '--profile', 'mentor-preview', 'https://example.org']).options.session, 'mentor-preview');
  assert.equal(parse(['open', '--session', 'review', '--profile', 'preview', 'https://example.org']).options.width, 1440);
  assert.deepEqual(parse(['viewport', '--session', 'review', '390', '844']).positional, [390, 844]);
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
    ['wait', '--session', 'review', '#thing', '--state', 'banana'],
    ['snapshot', '--session', 'review', '--timeout', '-1'],
    ['scroll', '--session', 'review'],
  ]) assert.throws(() => parse(args), { code: 'INVALID_ARGUMENT' }, args.join(' '));
});

test('literal values, scoped roles, coordinates and bounded names', () => {
  const parsed = parse(['fill', '--session', 'review', '--role', 'textbox', '--name', 'Title', '--', '--not-a-flag']);
  assert.deepEqual(parsed.positional, ['--not-a-flag']);
  assert.equal(parse(['scroll', '--session', 'review', '--y', '-200']).options.y, -200);
  assert.equal(parse(['click', '--session', 'review', '--role', 'button', '--name', 'Edit', '--within', '#card']).options.within, '#card');
  assert.throws(() => name('x'.repeat(49)), { code: 'INVALID_ARGUMENT' });
  assert.equal(webURL('http://localhost:3000'), 'http://localhost:3000/');
  assert.notEqual(paths({ BROWSER_CHECK_HOME: '/tmp/a' }).runtime, paths({ BROWSER_CHECK_HOME: '/tmp/b' }).runtime);
});
