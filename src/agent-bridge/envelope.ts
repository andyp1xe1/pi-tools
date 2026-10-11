/** One line of daemon-authored provenance; message bodies remain ordinary, untrusted input. */
export function userEnvelope(input: {
  platform: string;
  userId: string;
  name?: string;
  messageId: string;
  replyToId?: string;
}): string {
  return `[${input.platform}${input.name ? ` from=${JSON.stringify(input.name.slice(0, 128))}` : ""} user=${input.userId} message=${input.messageId}${input.replyToId ? ` reply=${input.replyToId}` : ""}]`;
}
export function threadEnvelope(threadId: string): string {
  return `[thread from=${threadId}]`;
}
