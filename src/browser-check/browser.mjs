import { mkdir, open } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fail, MAX_RESULT } from './shared.mjs';

async function unique(locator, { wait = true } = {}) {
  let count = await locator.count();
  if (count === 0 && wait) {
    await locator.waitFor({ state: 'attached' });
    count = await locator.count();
  }
  if (count !== 1) fail(count ? 'AMBIGUOUS_LOCATOR' : 'ELEMENT_NOT_FOUND', `Expected one element, found ${count}. Scope the locator with --within or use a more specific selector.`);
  return locator;
}
function target(page, request) {
  const o = request.options;
  const scope = o.within ? page.locator(o.within) : page;
  if (o.role !== undefined) return scope.getByRole(o.role, { name: o.name, exact: true });
  if (o.text !== undefined) return scope.getByText(o.text, { exact: true });
  return scope.locator(request.positional[0]);
}
async function destination(path, runDir, extension) {
  const output = path || join(runDir, `${Date.now()}-${randomUUID().slice(0, 8)}.${extension}`);
  await mkdir(dirname(output), { recursive: true, mode: 0o700 });
  // Refuse overwrites, including symlinks. Failed captures may leave an empty reserved file.
  const handle = await open(output, 'wx', 0o600);
  await handle.close();
  return output;
}
export async function operate(browser, request) {
  const { page, context, runDir } = browser;
  const { command, options: o, positional: a } = request;
  page.setDefaultTimeout(request.timeout);
  page.setDefaultNavigationTimeout(request.timeout);
  if (page.isClosed()) fail('PAGE_CLOSED', 'The controlled page was closed. Close this session and open a new one.');
  switch (command) {
    case 'goto':
      await page.goto(a[0], { waitUntil: 'domcontentloaded' });
      return { url: page.url() };
    case 'viewport':
      await page.setViewportSize({ width: a[0], height: a[1] });
      return { viewport: page.viewportSize() };
    case 'snapshot': {
      const tree = await (await unique(page.locator(a[0] || 'body'))).ariaSnapshot();
      return { tree: tree.slice(0, 12_000), truncated: tree.length > 12_000 };
    }
    case 'eval': {
      // Only this string runs in the page. It never runs in the worker's Node context.
      const expression = `(async () => {
        const value = await (async () => { ${request.code}\n })();
        const json = JSON.stringify(value === undefined ? null : value);
        if (json === undefined) throw new Error('Return a JSON-serializable value.');
        if (json.length > ${MAX_RESULT / 2}) throw new Error('Result too large. Return fewer fields or elements.');
        return JSON.parse(json);
      })()`;
      return { value: await page.evaluate(expression) };
    }
    case 'rect':
    case 'styles': {
      const locator = page.locator(a[0]);
      if (!o.all) await unique(locator);
      else if (await locator.count() > 200) fail('OUTPUT_TOO_LARGE', '--all supports at most 200 elements. Narrow the selector.');
      const values = await locator.evaluateAll((elements, { command, properties }) => elements.map((el) => {
        const css = getComputedStyle(el);
        if (command === 'styles') return Object.fromEntries(properties.map((p) => [p, css.getPropertyValue(p)]));
        return {
          tag: el.tagName.toLowerCase(), rect: el.getBoundingClientRect().toJSON(),
          client: { width: el.clientWidth, height: el.clientHeight },
          scroll: { width: el.scrollWidth, height: el.scrollHeight, left: el.scrollLeft, top: el.scrollTop },
          overflow: { x: css.overflowX, y: css.overflowY },
          display: css.display, visibility: css.visibility,
        };
      }), { command, properties: a.slice(1) });
      return { elements: values };
    }
    case 'screenshot': {
      const path = await destination(a[0], runDir, 'png');
      await page.screenshot({ path, type: 'png', fullPage: !!o['full-page'], timeout: request.timeout });
      return { path, viewport: page.viewportSize() };
    }
    case 'click': {
      const locator = await unique(target(page, request));
      await locator.click(o.x === undefined ? {} : { position: { x: o.x, y: o.y } });
      return { clicked: true };
    }
    case 'fill':
      await (await unique(target(page, request))).fill(a.at(-1));
      return { filled: true };
    case 'press':
      await (await unique(target(page, request))).press(a.at(-1));
      return { pressed: true };
    case 'hover':
      await (await unique(target(page, request))).hover();
      return { hovered: true };
    case 'wait': {
      const locator = target(page, request);
      if (await locator.count() > 1) fail('AMBIGUOUS_LOCATOR', 'Wait target matches multiple elements. Use --within or a more specific selector.');
      await locator.waitFor({ state: o.state || 'visible' });
      return { state: o.state || 'visible' };
    }
    case 'scroll': {
      const delta = { x: o.x || 0, y: o.y || 0 };
      const position = a[0]
        ? await (await unique(page.locator(a[0]))).evaluate((el, { x, y }) => {
          el.scrollBy({ left: x, top: y, behavior: 'instant' });
          return { x: el.scrollLeft, y: el.scrollTop };
        }, delta)
        : await page.evaluate(({ x, y }) => {
          window.scrollBy({ left: x, top: y, behavior: 'instant' });
          return { x: window.scrollX, y: window.scrollY };
        }, delta);
      return { position };
    }
    case 'trace':
      if (a[0] === 'start') {
        if (browser.tracing) fail('TRACE_ACTIVE', 'Tracing is already active.');
        await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
        browser.tracing = true;
        return { tracing: true };
      } else {
        if (!browser.tracing) fail('NO_TRACE', 'Start tracing first.');
        const path = await destination(a[1], runDir, 'zip');
        await context.tracing.stop({ path });
        browser.tracing = false;
        return { path, tracing: false };
      }
    default: fail('INVALID_ARGUMENT', `Unsupported browser command: ${command}`);
  }
}
