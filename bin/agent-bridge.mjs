#!/usr/bin/env -S bun --no-env-file
import { run } from "../src/agent-bridge/daemon.ts";
import { errorMessage, log } from "../src/agent-bridge/log.ts";
try {
  const mode = process.argv[2] ?? "start";
  const backend = mode === "start" ? new (await import("../src/pi-backend/index.ts")).PiSessionBackend() : undefined;
  await run({ backend });
} catch (error) {
  log({ level: "error", event: "bridge.failed", details: { message: errorMessage(error) } });
  process.exitCode = 1;
}
