export function makeKey(start: unknown, end: unknown): string {
  const norm = (v: unknown) =>
    typeof v === "number" ? Math.round(v) : String(v).trim();
  return `${norm(start)}|${norm(end)}`;
}
