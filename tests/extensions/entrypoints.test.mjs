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
  ["telegram", "registerTelegram", ["telegram_attach"]],
];

function registry() {
  const registrations = [];
  const pi = new Proxy({}, {
    get: (_object, method) => (...args) => {
      registrations.push([method, method === "registerTool" ? args[0].name : args[0]]);
    },
  });
  return { pi, registrations };
}

test("every extension is a thin, explicit entrypoint into its matching src module", async () => {
  const files = (await readdir(new URL("../../extensions/", import.meta.url))).filter((file) => file.endsWith(".ts")).sort();
  assert.deepEqual(files, extensions.map(([name]) => `${name}.ts`).sort());
  for (const [name, register] of extensions) {
    const source = await readFile(new URL(`../../extensions/${name}.ts`, import.meta.url), "utf8");
    assert.match(source, new RegExp(`import \\{ ${register} \\} from "\\.\\./src/${name}/index\\.ts"`));
    assert.match(source, new RegExp(`${register}\\(pi\\)`));
    assert.ok(source.trim().split("\n").length <= 7, `${name} contains implementation logic`);
  }
});

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
  for (const [name, register, tools] of extensions) {
    const { default: entrypoint } = await import(`../../extensions/${name}.ts`);
    const source = await import(`../../src/${name}/index.ts`);
    const entryRegistry = registry();
    const sourceRegistry = registry();
    await entrypoint(entryRegistry.pi);
    await source[register](sourceRegistry.pi);
    assert.deepEqual(entryRegistry.registrations, sourceRegistry.registrations, name);
    assert.deepEqual(entryRegistry.registrations.filter(([method]) => method === "registerTool").map(([, tool]) => tool), tools, name);
  }
});
