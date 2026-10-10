import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEnvironment } from "../../src/agent-bridge/config.ts";

test("environment loading preserves explicit values and refuses public credentials", () => {
  const dir = mkdtempSync(join(tmpdir(), "bridge-env-"));
  const path = join(dir, "env");
  try {
    writeFileSync(path, "TELEGRAM_BOT_TOKEN=fake\nAGENT_BRIDGE_OWNER_IDS=7\n", { mode: 0o600 });
    const env: NodeJS.ProcessEnv = { AGENT_BRIDGE_ENV_FILE: path, TELEGRAM_BOT_TOKEN: "override" };
    loadEnvironment(env);
    expect(env.TELEGRAM_BOT_TOKEN).toBe("override");
    expect(env.AGENT_BRIDGE_OWNER_IDS).toBe("7");
    chmodSync(path, 0o644);
    expect(() => loadEnvironment(env)).toThrow("private");
  } finally {
    rmSync(dir, { recursive: true });
  }
});
