/**
 * Minimal editing of compose env files. Lines are kept as-is (including
 * comments and order) except for the keys being changed.
 */

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const LINE_RE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;
const SAFE_VALUE_RE = /^[A-Za-z0-9_./:@%+,=-]*$/;

export function isValidKey(key: string): boolean {
  return KEY_RE.test(key);
}

export function parseEnv(text: string): Map<string, string> {
  const vars = new Map<string, string>();
  for (const line of text.split("\n")) {
    const match = LINE_RE.exec(line);
    if (match) {
      vars.set(match[1]!, unquote(match[2]!.trim()));
    }
  }
  return vars;
}

function unquote(value: string): string {
  if (value.length >= 2 && value[0] === value.at(-1) && `'"`.includes(value[0]!)) {
    return value.slice(1, -1);
  }
  return value.replace(/\s+#.*$/, "");
}

/**
 * Format a value for an env file. Compose interpolates `$` and strips inline
 * comments in unquoted values, so anything beyond simple characters is single
 * quoted, which compose reads literally.
 */
export function formatValue(value: string): string {
  if (SAFE_VALUE_RE.test(value)) {
    return value;
  }
  if (value.includes("'") || value.includes("\n")) {
    throw new Error(
      "values containing single quotes or newlines aren't supported; edit the .env file by hand",
    );
  }
  return `'${value}'`;
}

export function setVars(text: string, updates: Record<string, string>): string {
  const remaining = new Map(Object.entries(updates));
  const lines = text === "" ? [] : text.replace(/\n$/, "").split("\n");
  const out = lines.map((line) => {
    const key = LINE_RE.exec(line)?.[1];
    if (key && remaining.has(key)) {
      const value = remaining.get(key)!;
      remaining.delete(key);
      return `${key}=${formatValue(value)}`;
    }
    return line;
  });
  for (const [key, value] of remaining) {
    out.push(`${key}=${formatValue(value)}`);
  }
  return out.length > 0 ? `${out.join("\n")}\n` : "";
}

export function unsetVars(text: string, keys: string[]): string {
  const drop = new Set(keys);
  const lines = text.split("\n").filter((line) => {
    const key = LINE_RE.exec(line)?.[1];
    return !(key && drop.has(key));
  });
  return lines.join("\n");
}
