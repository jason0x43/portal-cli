import { dirname, resolve } from "node:path";

export type Source =
  | {
      kind: "build";
      context: string;
      dockerfile: string;
      target?: string;
      args: Record<string, string>;
    }
  | { kind: "image"; image: string }
  | {
      kind: "static";
      dir: string;
      /** Page served (with a 200) for paths that don't exist, for SPAs */
      fallback?: string;
      /** URL path globs served with long-lived immutable caching */
      immutable: string[];
      /** Patterns for files to leave out of the image, in addition to .git and portal.toml */
      ignore: string[];
    };

export interface Config {
  name: string;
  domains: string[];
  /** Container port Caddy proxies to */
  port: number;
  /** ssh host */
  host: string;
  /** Server config directory on the host */
  root: string;
  source: Source;
  env: Record<string, string>;
  /** Opt in to a read-only root filesystem with a tmpfs /tmp */
  hardened: boolean;
  /** Deep-merged into the generated compose service */
  compose: Record<string, unknown>;
  /** Extra Caddy directives inside the site block */
  caddyExtra?: string;
  /** Directory containing portal.toml; relative paths resolve from here */
  dir: string;
}

export const DEFAULT_HOST = "portal";
export const DEFAULT_ROOT = "~/server";
export const CONFIG_FILE = "portal.toml";
/** Port the generated static-web-server image listens on */
export const STATIC_PORT = 8080;

const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
const DOMAIN_RE = /^(\*\.)?([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/;

export class ConfigError extends Error {}

export async function loadConfig(path = CONFIG_FILE): Promise<Config> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new ConfigError(
      `${path} not found (run \`portal init\` to create one)`,
    );
  }
  let raw: unknown;
  try {
    raw = Bun.TOML.parse(await file.text());
  } catch (err) {
    throw new ConfigError(`${path}: ${(err as Error).message}`);
  }
  return parseConfig(raw, dirname(resolve(path)));
}

export function parseConfig(raw: unknown, dir: string): Config {
  const errors: string[] = [];
  const obj = isRecord(raw) ? raw : {};

  const known = new Set([
    "name",
    "domain",
    "port",
    "host",
    "root",
    "build",
    "image",
    "static",
    "env",
    "hardened",
    "compose",
    "caddy",
  ]);
  for (const key of Object.keys(obj)) {
    if (!known.has(key)) {
      errors.push(`unknown key "${key}"`);
    }
  }

  const name = obj.name;
  if (typeof name !== "string" || !NAME_RE.test(name)) {
    errors.push(
      'name is required and must be lowercase letters, digits, and "-"',
    );
  }

  const domainValue = obj.domain;
  const domains =
    typeof domainValue === "string"
      ? [domainValue]
      : Array.isArray(domainValue)
        ? domainValue
        : [];
  if (domains.length === 0) {
    errors.push("domain is required (a string or array of strings)");
  }
  for (const d of domains) {
    if (typeof d !== "string" || !DOMAIN_RE.test(d)) {
      errors.push(`invalid domain ${JSON.stringify(d)}`);
    }
  }

  const sources = (["build", "image", "static"] as const).filter(
    (k) => obj[k] !== undefined,
  );
  let source: Source | undefined;
  if (sources.length !== 1) {
    errors.push('exactly one of "build", "image", or "static" is required');
  } else if (sources[0] === "build") {
    source = parseBuild(obj.build, errors);
  } else if (sources[0] === "image") {
    if (typeof obj.image !== "string" || obj.image === "") {
      errors.push("image must be an image reference string");
    } else {
      source = { kind: "image", image: obj.image };
    }
  } else {
    source = parseStatic(obj.static, errors);
  }

  let port = obj.port;
  if (source?.kind === "static") {
    if (port !== undefined) {
      errors.push("port does not apply to static sites");
    }
    port = STATIC_PORT;
  } else if (
    typeof port !== "number" ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  ) {
    errors.push("port is required and must be an integer from 1 to 65535");
  }

  const host = obj.host ?? DEFAULT_HOST;
  if (typeof host !== "string" || host === "") {
    errors.push("host must be a string");
  }
  const root = obj.root ?? DEFAULT_ROOT;
  if (typeof root !== "string" || root === "") {
    errors.push("root must be a string");
  }

  const env = parseStringMap(obj.env, "env", errors);

  const hardened = obj.hardened ?? false;
  if (typeof hardened !== "boolean") {
    errors.push("hardened must be true or false");
  }

  const compose = obj.compose ?? {};
  if (!isRecord(compose)) {
    errors.push("[compose] must be a table");
  } else {
    checkComposeOverrides(compose, errors);
  }

  let caddyExtra: string | undefined;
  if (obj.caddy !== undefined) {
    if (!isRecord(obj.caddy)) {
      errors.push("[caddy] must be a table");
    } else {
      for (const key of Object.keys(obj.caddy)) {
        if (key !== "extra") {
          errors.push(`unknown key "caddy.${key}"`);
        }
      }
      if (obj.caddy.extra !== undefined) {
        if (typeof obj.caddy.extra !== "string") {
          errors.push("caddy.extra must be a string");
        } else {
          caddyExtra = obj.caddy.extra;
        }
      }
    }
  }

  if (errors.length > 0) {
    throw new ConfigError(
      `invalid ${CONFIG_FILE}:\n${errors.map((e) => `  - ${e}`).join("\n")}`,
    );
  }

  return {
    name: name as string,
    domains: domains as string[],
    port: port as number,
    host: host as string,
    root: root as string,
    source: source!,
    env,
    hardened: hardened as boolean,
    compose: compose as Record<string, unknown>,
    caddyExtra,
    dir,
  };
}

function parseBuild(value: unknown, errors: string[]): Source | undefined {
  if (value === true) {
    return { kind: "build", context: ".", dockerfile: "Dockerfile", args: {} };
  }
  if (!isRecord(value)) {
    errors.push("build must be true or a table");
    return;
  }
  for (const key of Object.keys(value)) {
    if (!["context", "dockerfile", "target", "args"].includes(key)) {
      errors.push(`unknown key "build.${key}"`);
    }
  }
  const context = value.context ?? ".";
  const dockerfile = value.dockerfile ?? "Dockerfile";
  if (typeof context !== "string") {
    errors.push("build.context must be a string");
  }
  if (typeof dockerfile !== "string") {
    errors.push("build.dockerfile must be a string");
  }
  if (value.target !== undefined && typeof value.target !== "string") {
    errors.push("build.target must be a string");
  }
  return {
    kind: "build",
    context: context as string,
    dockerfile: dockerfile as string,
    target: value.target as string | undefined,
    args: parseStringMap(value.args, "build.args", errors),
  };
}

function parseStatic(value: unknown, errors: string[]): Source | undefined {
  if (typeof value === "string" && value !== "") {
    return { kind: "static", dir: value, immutable: [], ignore: [] };
  }
  if (!isRecord(value)) {
    errors.push("static must be a directory path or a table with dir");
    return;
  }
  for (const key of Object.keys(value)) {
    if (!["dir", "fallback", "immutable", "ignore"].includes(key)) {
      errors.push(`unknown key "static.${key}"`);
    }
  }
  const { dir, fallback } = value;
  if (typeof dir !== "string" || dir === "") {
    errors.push("static.dir must be the path of the directory to serve");
  }
  if (fallback !== undefined && (typeof fallback !== "string" || fallback === "")) {
    errors.push("static.fallback must be a file path within the directory");
  }
  return {
    kind: "static",
    dir: dir as string,
    fallback: fallback as string | undefined,
    immutable: parseGlobs(value.immutable, "static.immutable", errors),
    ignore: parseGlobs(value.ignore, "static.ignore", errors),
  };
}

function parseGlobs(value: unknown, label: string, errors: string[]): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.some((g) => typeof g !== "string" || g.trim() === "")) {
    errors.push(`${label} must be an array of glob patterns`);
    return [];
  }
  return value as string[];
}

function parseStringMap(
  value: unknown,
  label: string,
  errors: string[],
): Record<string, string> {
  if (value === undefined) {
    return {};
  }
  if (!isRecord(value)) {
    errors.push(`${label} must be a table`);
    return {};
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (
      typeof v === "string" ||
      typeof v === "number" ||
      typeof v === "boolean"
    ) {
      out[k] = String(v);
    } else {
      errors.push(`${label}.${k} must be a string, number, or boolean`);
    }
  }
  return out;
}

/**
 * Reject compose overrides that would break the server's invariants: services
 * are only reachable through the tunnel, and all state lives under the service
 * directory where backups can find it.
 */
function checkComposeOverrides(
  compose: Record<string, unknown>,
  errors: string[],
) {
  if ("ports" in compose) {
    errors.push(
      "compose.ports is not allowed: published ports bypass the Cloudflare tunnel and the host firewall",
    );
  }
  if ("network_mode" in compose) {
    errors.push(
      "compose.network_mode is not allowed: services must stay on the server network",
    );
  }
  for (const key of ["image", "build", "container_name"]) {
    if (key in compose) {
      errors.push(`compose.${key} is managed by portal and can't be set`);
    }
  }
  if ("volumes" in compose) {
    const volumes = compose.volumes;
    if (!Array.isArray(volumes)) {
      errors.push("compose.volumes must be an array");
    } else {
      for (const v of volumes) {
        const source =
          typeof v === "string"
            ? v.split(":")[0]
            : isRecord(v)
              ? v.type === "tmpfs"
                ? "./"
                : v.source
              : undefined;
        if (typeof source !== "string" || !source.startsWith("./")) {
          errors.push(
            `compose.volumes entry ${JSON.stringify(v)} must be a bind mount under the service dir (./...); named volumes aren't backed up`,
          );
        }
      }
    }
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
