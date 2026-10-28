const color = process.stderr.isTTY && !process.env.NO_COLOR;

const paint = (code: string) => (text: string) =>
  color ? `\x1b[${code}m${text}\x1b[0m` : text;

export const bold = paint("1");
export const dim = paint("2");
export const red = paint("31");
export const green = paint("32");
export const yellow = paint("33");
export const cyan = paint("36");

/** Whether a spinner is drawn on the current stderr line. */
let spinning = false;

/** Clear a spinner's line so a message can be printed in its place. */
function clearSpinner() {
  if (spinning) {
    process.stderr.write("\r\x1b[2K");
  }
}

/** Progress goes to stderr so command output on stdout stays clean. */
export function step(message: string) {
  clearSpinner();
  console.error(`${cyan("→")} ${message}`);
}

export function done(message: string) {
  clearSpinner();
  console.error(`${green("✓")} ${message}`);
}

export function warn(message: string) {
  clearSpinner();
  console.error(`${yellow("!")} ${message}`);
}

const SPINNER_FRAMES = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";

/**
 * Show `message` with a spinner on stderr while `work` runs, if stderr is a
 * terminal. Messages printed meanwhile appear above it. With `persist`, the
 * message is left behind as a step, as it's always printed when stderr isn't
 * a terminal.
 */
export async function spin<T>(
  message: string,
  work: Promise<T>,
  { persist = false } = {},
): Promise<T> {
  if (!process.stderr.isTTY || spinning) {
    if (persist) {
      step(message);
    }
    return work;
  }
  let frame = 0;
  const draw = () =>
    process.stderr.write(`\r\x1b[2K${cyan(SPINNER_FRAMES[frame++ % SPINNER_FRAMES.length]!)} ${message}`);
  spinning = true;
  draw();
  const timer = setInterval(draw, 80);
  try {
    return await work;
  } finally {
    clearInterval(timer);
    clearSpinner();
    spinning = false;
    if (persist) {
      step(message);
    }
  }
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
