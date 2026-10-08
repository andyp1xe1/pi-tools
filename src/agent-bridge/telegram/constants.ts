import { homedir } from "node:os";
import { join } from "node:path";

export const TEMP_DIR = join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "agent-bridge", "telegram");
export const TELEGRAM_PREFIX = "[telegram]";
export const MAX_MESSAGE_LENGTH = 4096;
export const PREVIEW_THROTTLE_MS = 750;
export const TELEGRAM_MEDIA_GROUP_DEBOUNCE_MS = 1200;
