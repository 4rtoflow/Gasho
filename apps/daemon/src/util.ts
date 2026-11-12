export function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}… (+${s.length - max} chars)`;
}

export function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/** The most telling field of a tool input (command, file path, …), taken before the input is clipped. */
export function inputSummary(input: unknown, max: number): string {
  if (!input || typeof input !== "object") return "";
  const i = input as Record<string, unknown>;
  const pick = i.command ?? i.file_path ?? i.path ?? i.pattern ?? i.url ?? i.query ?? i.description ?? i.prompt;
  return clip(typeof pick === "string" ? pick : JSON.stringify(i), max);
}

export function log(...args: unknown[]): void {
  console.log(new Date().toISOString(), "[gasho-daemon]", ...args);
}
