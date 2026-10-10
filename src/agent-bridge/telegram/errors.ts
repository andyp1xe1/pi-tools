export class TelegramError extends Error {
  constructor(
    readonly code: number,
    readonly retryAfter?: number,
  ) {
    super(`Telegram API error ${code}`);
  }
}
export class TelegramAttachmentError extends Error {}
export class TelegramDeliveryUnknown extends Error {
  constructor() {
    super("Telegram delivery outcome is unknown. It will not be resent automatically.");
  }
}
