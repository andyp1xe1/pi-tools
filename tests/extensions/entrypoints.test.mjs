import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const extensions = [
  ["audio-transcription", "registerAudioTranscription", ["transcribe_audio"]],
  ["dev-shell-manager", "registerDevShellManager", ["ensure_dev_shell"]],
  ["latex-renderer", "registerLatexRenderer", ["render_latex"]],
  ["nix-env-feedback", "registerNixEnvFeedback", []],
  ["pi-pkm", "registerPiPkm", []],
  ["telegram", "registerBot", ["telegram_attach"], "bot"],
];

function registry() {
  const registrations = [];
  const tools = new Map();
  const handlers = new Map();
  let bound = false;
  const pi = new Proxy({}, {
    get: (_object, method) => (...args) => {
      if (method === "getAllTools") {
        assert.ok(bound, "tool inventory is not bound during factory loading");
        return [...tools.values()];
      }
      registrations.push([method, method === "registerTool" ? args[0].name : args[0]]);
      if (method === "registerTool") tools.set(args[0].name, args[0]);
      if (method === "on") {
        const list = handlers.get(args[0]) ?? [];
        list.push(args[1]);
        handlers.set(args[0], list);
      }
    },
  });
  const start = async () => {
    bound = true;
    const ctx = {
      cwd: process.cwd(), isIdle: () => true,
      ui: { setStatus() {} }, sessionManager: { getSessionId: () => "audio-test" },
    };
    for (const handler of handlers.get("session_start") ?? []) await handler({ reason: "startup" }, ctx);
  };
  return { pi, registrations, tools, start };
}

test("every extension is a thin, explicit entrypoint into its source module", async () => {
  const files = (await readdir(new URL("../../extensions/", import.meta.url))).filter((file) => file.endsWith(".ts")).sort();
  assert.deepEqual(files, extensions.map(([name]) => `${name}.ts`).sort());
  for (const [name, register, _tools, module = name] of extensions) {
    const source = await readFile(new URL(`../../extensions/${name}.ts`, import.meta.url), "utf8");
    assert.match(source, new RegExp(`import \\{ ${register} \\} from "\\.\\./src/${module}/index\\.ts"`));
    assert.match(source, new RegExp(`${register}\\(pi\\)`));
    assert.ok(source.trim().split("\n").length <= 7, `${name} contains implementation logic`);
  }
});

for (const [local, order] of [
  [true, ["audio-transcription", "telegram"]],
  [true, ["telegram", "audio-transcription"]],
  [false, ["audio-transcription", "telegram"]],
  [false, ["telegram", "audio-transcription"]],
]) {
  test(`one transcription registration (${local ? "local Whisper" : "remote-only"}) for extension load order: ${order.join(" then ")}`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "pi-load-order-"));
    if (local) {
      await writeFile(join(directory, "whisper"), "fake executable (never spawned)");
      await chmod(join(directory, "whisper"), 0o755);
    }
    const oldPath = process.env.PATH;
    process.env.PATH = directory;
    const intent = Symbol.for("pi-tools.agent-bridge.attachment-intent");
    Reflect.deleteProperty(globalThis, intent);
    t.after(async () => {
      Reflect.deleteProperty(globalThis, intent);
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
      await rm(directory, { recursive: true, force: true });
    });
    const h = registry();
    for (const name of order) await (await import(`../../extensions/${name}.ts`)).default(h.pi);
    assert.equal(h.tools.has("transcribe_audio"), false);
    await h.start();
    await h.start(); // repeated starts must not duplicate a definition
    assert.equal(h.registrations.filter(([method, name]) => method === "registerTool" && name === "transcribe_audio").length, 1);
    assert.deepEqual([...h.tools.keys()].sort(), ["telegram_attach", "transcribe_audio"]);
  });
}

test("entrypoints preserve source registrations and existing tool names", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-entrypoints-"));
  await writeFile(join(directory, "whisper"), "#!/bin/sh\nexit 0\n");
  await chmod(join(directory, "whisper"), 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = directory;
  t.after(async () => {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    await rm(directory, { recursive: true, force: true });
  });
  for (const [name, register, tools, module = name] of extensions) {
    const { default: entrypoint } = await import(`../../extensions/${name}.ts`);
    const source = await import(`../../src/${module}/index.ts`);
    const entryRegistry = registry();
    const sourceRegistry = registry();
    await entrypoint(entryRegistry.pi);
    await source[register](sourceRegistry.pi);
    if (name === "audio-transcription") {
      await entryRegistry.start();
      await sourceRegistry.start();
    }
    assert.deepEqual(entryRegistry.registrations, sourceRegistry.registrations, name);
    assert.deepEqual(entryRegistry.registrations.filter(([method]) => method === "registerTool").map(([, tool]) => tool), tools, name);
  }
});
