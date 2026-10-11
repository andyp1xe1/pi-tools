import { MAX_MESSAGE_LENGTH } from "./constants.ts";

export function chunkParagraphs(text: string): string[] {
  if (text.length <= MAX_MESSAGE_LENGTH) return [text];

  const paragraphs = text.replace(/\r\n/g, "\n").split(/\n\n+/);
  const chunks: string[] = [];
  let current = "";

  const flush = (): void => {
    if (current.trim()) chunks.push(current);
    current = "";
  };

  const splitLongBlock = (block: string): string[] => {
    if (block.length <= MAX_MESSAGE_LENGTH) return [block];
    const parts: string[] = [];
    let currentLine = "";

    for (const line of block.split("\n")) {
      const candidate = currentLine ? `${currentLine}\n${line}` : line;
      if (candidate.length <= MAX_MESSAGE_LENGTH) {
        currentLine = candidate;
        continue;
      }
      if (currentLine) parts.push(currentLine);
      currentLine = "";
      if (line.length <= MAX_MESSAGE_LENGTH) {
        currentLine = line;
      } else {
        for (let index = 0; index < line.length; index += MAX_MESSAGE_LENGTH) {
          parts.push(line.slice(index, index + MAX_MESSAGE_LENGTH));
        }
      }
    }
    if (currentLine) parts.push(currentLine);
    return parts;
  };

  for (const paragraph of paragraphs) {
    if (!paragraph) continue;
    for (const part of splitLongBlock(paragraph)) {
      const candidate = current ? `${current}\n\n${part}` : part;
      if (candidate.length <= MAX_MESSAGE_LENGTH) current = candidate;
      else {
        flush();
        current = part;
      }
    }
  }
  flush();
  return chunks;
}
