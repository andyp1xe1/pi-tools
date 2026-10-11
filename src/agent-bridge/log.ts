export function log(entry: {
  level: "info" | "warn" | "error";
  event: string;
  details?: Record<string, unknown>;
}): void {
  process.stderr.write(`${JSON.stringify({ time: new Date().toISOString(), ...entry })}\n`);
}
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}
