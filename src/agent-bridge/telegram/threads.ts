/** Compatibility export; all transports share the bot thread lifecycle. */
export {
  type ThreadHost,
  ThreadOperationError,
  ThreadOperations as TelegramThreadOperations,
} from "../../bot/thread-operations.ts";
