import { closeSync, constants, fstatSync, mkdirSync, openSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { parseEnv } from "node:util";

export interface Config {
  database: string;
  ownerTelegramUserIds: string[];
}

export function environmentPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.AGENT_BRIDGE_ENV_FILE ?? join(env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "agent-bridge", "env");
}
export function loadEnvironment(env: NodeJS.ProcessEnv = process.env): void {
  const path = environmentPath(env);
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      (stat.mode & 0o077) !== 0 ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw new Error(
        "The bridge environment file must be private (mode 0600), without links, and owned by this user.",
      );
    for (const [key, value] of Object.entries(parseEnv(readFileSync(fd, "utf8"))))
      if (env[key] === undefined) env[key] = value;
  } finally {
    closeSync(fd);
  }
}

/**
 * Creates/canonicalizes the parent and checks it and its ancestors against substitution.
 * Returns the destination path without validating or creating the destination itself.
 */
export function preparePrivatePath(input: string): string {
  const path = resolve(input);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const parent = realpathSync(dirname(path));
  const uid = process.getuid?.();
  const immediate = statSync(parent);
  if ((immediate.mode & 0o022) !== 0 || (uid !== undefined && immediate.uid !== uid)) {
    throw new Error("The destination directory must be owned by this user and not writable by other users.");
  }
  for (let directory = parent; ; directory = dirname(directory)) {
    const stat = statSync(directory);
    const trustedOwner = uid === undefined || stat.uid === uid || stat.uid === 0;
    const protectedDirectory = (stat.mode & 0o022) === 0 || (stat.mode & 0o1000) !== 0;
    if (!trustedOwner || !protectedDirectory) {
      throw new Error(
        "A destination directory ancestor allows substitution by another user. Choose a private data path.",
      );
    }
    if (dirname(directory) === directory) break;
  }
  return join(parent, basename(path));
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const owners = (env.AGENT_BRIDGE_OWNER_IDS ?? "").split(/[\s,]+/).filter(Boolean);
  if (owners.some((id) => !/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id)))) {
    throw new Error("AGENT_BRIDGE_OWNER_IDS must contain positive Telegram user IDs, separated by commas.");
  }
  const dataHome = env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
  return {
    database: resolve(env.AGENT_BRIDGE_DATABASE ?? join(dataHome, "agent-bridge", "bridge.sqlite")),
    ownerTelegramUserIds: [...new Set(owners)],
  };
}
