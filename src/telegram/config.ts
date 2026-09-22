import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { CONFIG_PATH } from "./constants.ts";
import type { TelegramConfig } from "./types.ts";

export async function readTelegramConfig(): Promise<TelegramConfig> {
  try {
    return JSON.parse(await readFile(CONFIG_PATH, "utf8")) as TelegramConfig;
  } catch {
    return {};
  }
}

export async function writeTelegramConfig(config: TelegramConfig): Promise<void> {
  await mkdir(dirname(CONFIG_PATH), { recursive: true });
  await writeFile(CONFIG_PATH, `${JSON.stringify(config, null, "\t")}\n`, "utf8");
}
