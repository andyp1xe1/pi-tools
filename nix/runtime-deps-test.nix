# Exercise validation from the installed extension package without browser or daemon dependencies.
{self, pkgs}: let
  packages = self.packages.${pkgs.stdenv.hostPlatform.system};
in pkgs.runCommand "check-extension-runtime" {
  nativeBuildInputs = [pkgs.nodejs_22];
} ''
  cd ${packages.without-browser-cli}
  test "$(readlink node_modules)" = "${packages.runtime-deps}/node_modules"
  test -f node_modules/valibot/LICENSE.md
  test ! -e node_modules/playwright
  test ! -e bin/browser-cli.mjs
  test -f extensions/bot.ts
  test ! -e extensions/telegram.ts
  node --experimental-transform-types --input-type=module <<'JS'
  import assert from "node:assert/strict";
  import * as v from "valibot";
  import { BridgeClient, captureBridgeTranscription, registerBridgeTranscription } from "./src/agent-bridge/client.ts";
  import { ClientFrameSchema } from "./src/agent-bridge/protocol.ts";
  import { BridgeServer } from "./src/agent-bridge/server.ts";
  assert.equal(typeof BridgeClient, "function");
  assert.equal(typeof BridgeServer, "function");
  assert.deepEqual(v.parse(ClientFrameSchema, { type: "status" }), { type: "status" });
  assert.equal(v.safeParse(ClientFrameSchema, { type: "invalid" }).success, false);
  const unregister = registerBridgeTranscription("packaging-check", async () => "transcript");
  assert.equal(await captureBridgeTranscription()({ path: "/unused.wav" }), "transcript");
  unregister();
  assert.equal(captureBridgeTranscription(), undefined);
  JS
  touch "$out"
''
