const color = process.stderr.isTTY && !process.env.NO_COLOR;

const paint = (code: string) => (text: string) =>
  color ? `\x1b[${code}m${text}\x1b[0m` : text;

export const bold = paint("1");
export const dim = paint("2");
export const red = paint("31");
export const green = paint("32");
export const yellow = paint("33");
export const cyan = paint("36");

/** Progress goes to stderr so command output on stdout stays clean. */
export function step(message: string) {
  console.error(`${cyan("→")} ${message}`);
}

export function done(message: string) {
  console.error(`${green("✓")} ${message}`);
}

export function warn(message: string) {
  console.error(`${yellow("!")} ${message}`);
}

export function confirm(question: string): boolean {
  if (!process.stdin.isTTY) {
    return false;
  }
  const answer = prompt(`${question} [y/N]`);
  return answer?.trim().toLowerCase() === "y";
}

/** Print rows to stdout in aligned columns under a bold header. */
export function printTable(header: string[], rows: string[][]) {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const format = (r: string[]) =>
    r.map((c, i) => (i < r.length - 1 ? c.padEnd(widths[i]!) : c)).join("  ");
  console.log(bold(format(header)));
  for (const row of rows) {
    console.log(format(row));
  }
}
