import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { test } from "node:test";
import { registerAudioTranscription, registerAudioTranscriptionTool } from "../../src/audio-transcription/index.ts";
import { captureBridgeTranscription, registerBridgeTranscription } from "../../src/agent-bridge/client.ts";

async function harness(t, { local = true, transcript = "local transcript" } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "pi-audio-test-"));
  const oldPath = process.env.PATH;
  process.env.PATH = dir;
  if (local) {
    await writeFile(join(dir, "whisper"), "fake executable (never spawned)");
    await chmod(join(dir, "whisper"), 0o755);
  }
  await writeFile(join(dir, "audio.ogg"), "fake audio (never decoded)");
  const tools = new Map(), handlers = [], calls = [], updates = [];
  const pi = {
    registerTool: (tool) => { assert.ok(!tools.has(tool.name)); tools.set(tool.name, tool); },
    getAllTools: () => [...tools.values()], on: (_event, fn) => handlers.push(fn),
    exec: async (command, args, options) => {
      calls.push({ command, args, options });
      options.signal?.throwIfAborted();
      await writeFile(join(args[args.indexOf("--output_dir") + 1], `${parse(args[0]).name}.txt`), transcript);
      return { code: 0, stdout: "", stderr: "" };
    },
  };
  const releases = [];
  t.after(async () => {
    for (const release of releases) release();
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    await rm(dir, { recursive: true, force: true });
  });
  return {
    dir, pi, tools, calls, updates,
    start: async () => { for (const fn of handlers) await fn({}, {}); },
    bridge: (provider, key = "audio-test") => { const release = registerBridgeTranscription(key, provider); releases.push(release); return release; },
    execute: (params = { path: "@audio.ogg" }, signal) => tools.get("transcribe_audio").execute("audio", params, signal, (update) => updates.push(update), { cwd: dir }),
  };
}

test("standalone detached execution uses local Whisper with normalized path and shared defaults", async (t) => {
  const h = await harness(t);
  await registerAudioTranscription(h.pi);
  assert.equal(h.tools.size, 0);
  await h.start();
  const result = await h.execute({ path: "@audio.ogg", model: " tiny ", language: " en " });
  assert.equal(result.content[0].text, "local transcript");
  assert.equal(result.details.path, join(h.dir, "audio.ogg"));
  assert.equal(h.calls[0].command, join(h.dir, "whisper"));
  assert.ok(h.calls[0].args.includes("tiny"));
  assert.ok(h.calls[0].args.includes("en"));
  assert.equal(h.updates.length, 1);
  await assert.rejects(stat(h.calls[0].args[h.calls[0].args.indexOf("--output_dir") + 1]), { code: "ENOENT" });
});

test("remote-only registration works without Whisper; daemon defaults and errors never fall back", async (t) => {
  const h = await harness(t, { local: false });
  await registerAudioTranscription(h.pi);
  await h.start();
  assert.equal(h.tools.size, 0);
  registerAudioTranscriptionTool(h.pi);
  const requests = [];
  h.bridge(async (request) => { requests.push(request); return "remote transcript"; });
  assert.equal((await h.execute()).content[0].text, "remote transcript");
  assert.equal(requests[0].model, undefined);
  assert.equal(requests[0].language, undefined);
  assert.equal(requests[0].path, join(h.dir, "audio.ogg"));
  h.bridge(async () => { throw new Error("daemon unavailable"); });
  await assert.rejects(h.execute(), /daemon unavailable/);
  assert.equal(h.calls.length, 0);
});

test("shared path validation rejects directories and missing files without dispatching transcription", async (t) => {
  const h = await harness(t);
  registerAudioTranscriptionTool(h.pi);
  let calls = 0;
  h.bridge(async () => { calls++; return "unused"; });
  await assert.rejects(h.execute({ path: "." }), /Not a file/);
  await assert.rejects(h.execute({ path: "missing.ogg" }), { code: "ENOENT" });
  assert.equal(calls, 0);
  assert.equal(h.calls.length, 0);
});

test("daemon failure with local Whisper installed never invokes the local executor", async (t) => {
  const h = await harness(t);
  registerAudioTranscriptionTool(h.pi);
  h.bridge(async () => { throw new Error("daemon failed"); });
  await assert.rejects(h.execute(), /daemon failed/);
  assert.equal(h.calls.length, 0);
});

test("provider captured before filesystem await cannot switch to a newer attachment", async (t) => {
  const h = await harness(t);
  registerAudioTranscriptionTool(h.pi);
  let attached = true, newerCalls = 0;
  const release = h.bridge(async () => {
    if (!attached) throw new Error("attachment changed");
    return "old";
  });
  const pending = h.execute();
  attached = false;
  release();
  h.bridge(async () => { newerCalls++; return "new"; });
  await assert.rejects(pending, /attachment changed/);
  assert.equal(newerCalls, 0);
  assert.equal(h.calls.length, 0);
  assert.equal((await h.execute()).content[0].text, "new");
});

test("a detached call remains local even if a daemon attaches during path validation", async (t) => {
  const h = await harness(t);
  registerAudioTranscriptionTool(h.pi);
  const pending = h.execute();
  h.bridge(async () => assert.fail("late attachment must not take this call"));
  assert.equal((await pending).content[0].text, "local transcript");
  assert.equal(h.calls.length, 1);
});

test("cancellation fences path validation and propagates to in-flight daemon execution", async (t) => {
  const h = await harness(t);
  registerAudioTranscriptionTool(h.pi);
  let remoteCalls = 0;
  h.bridge(async ({ signal }) => {
    remoteCalls++;
    assert.ok(signal);
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  });
  const pre = new AbortController(); pre.abort();
  await assert.rejects(h.execute(undefined, pre.signal), { name: "AbortError" });
  const validating = new AbortController();
  const validation = h.execute(undefined, validating.signal); validating.abort();
  await assert.rejects(validation, { name: "AbortError" });
  assert.equal(remoteCalls, 0);
  const controller = new AbortController();
  const pending = h.execute(undefined, controller.signal);
  // Progress is emitted synchronously immediately before the provider call.
  while (remoteCalls === 0) await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(h.calls.length, 0);
});

for (const [limit, transcript] of [["lines", "line\n".repeat(2100)], ["bytes", "é".repeat(30000)]]) {
  test(`shared transcript ${limit} truncation retains the complete private temp output`, async (t) => {
    const h = await harness(t);
    registerAudioTranscriptionTool(h.pi);
    h.bridge(async () => transcript);
    const result = await h.execute();
    const output = result.details.fullOutputPath;
    t.after(() => rm(parse(output).dir, { recursive: true, force: true }));
    assert.equal(await readFile(output, "utf8"), transcript);
    assert.equal((await stat(output)).mode & 0o777, 0o600);
    assert.ok(result.details.truncation.truncated);
    assert.ok(result.details.truncation.outputLines <= 2000);
    assert.ok(result.details.truncation.outputBytes <= 50 * 1024);
    assert.match(result.content[0].text, /Transcript truncated.*Full transcript saved to:/s);
  });
}

test("local cancellation cleans Whisper output even when an executor ignores the signal", async (t) => {
  const h = await harness(t);
  registerAudioTranscriptionTool(h.pi);
  const controller = new AbortController();
  let output;
  h.pi.exec = async (_command, args, { signal }) => {
    assert.equal(signal, controller.signal);
    output = args[args.indexOf("--output_dir") + 1];
    controller.abort();
    return { code: 0, stdout: "", stderr: "" };
  };
  await assert.rejects(h.execute(undefined, controller.signal), { name: "AbortError" });
  await assert.rejects(readdir(output), { code: "ENOENT" });
});

test("old registry cleanup cannot unregister a replacement even when its key is reused", async (t) => {
  const h = await harness(t);
  const old = h.bridge(async () => "old");
  h.bridge(async () => "new");
  old();
  assert.equal(await captureBridgeTranscription()({ path: "unused" }), "new");
});
