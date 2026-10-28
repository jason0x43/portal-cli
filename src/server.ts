import { existsSync } from "node:fs";
import {
  CONFIG_FILE,
  ConfigError,
  DEFAULT_HOST,
  DEFAULT_ROOT,
  loadConfig,
  type Config,
} from "./config.ts";
import { servicePath } from "./compose.ts";
import { q, Remote, type RunOptions, type RunResult } from "./remote.ts";
import { dim, spin } from "./ui.ts";

export const CADDYFILE = "/etc/caddy/Caddyfile";

export const sitePath = (name: string) => `caddy/sites/${name}.caddy`;
export const envPath = (name: string) => `services/${name}/.env`;

/**
 * Marks a disabled service. It holds the service's real Caddy route while a
 * 503 route stands in for it, so `enable` can put it back without the
 * project's portal.toml.
 */
export const disabledPath = (name: string) => `services/${name}/disabled`;

export function isDisabled(remote: Remote, name: string): Promise<boolean> {
  return remote.exists(disabledPath(name));
}

/**
 * Recreate the service's container so it picks up a new image, compose file
 * or .env, and wait for it to come up. A disabled service's container is only
 * created, so it stays stopped until `portal enable`. Returns whether the
 * container was started.
 */
export async function recreateService(
  remote: Remote,
  name: string,
  { timeout }: { timeout?: number } = {},
): Promise<boolean> {
  if (await isDisabled(remote, name)) {
    await serviceCompose(remote, name, "create --force-recreate", { inherit: true });
    return false;
  }
  await serviceCompose(remote, name, "up -d --force-recreate", { inherit: true });
  await waitForService(remote, name, { timeout });
  return true;
}

/** `docker compose` for a service's own project (services/<name>/compose.yaml). */
export function serviceCompose(
  remote: Remote,
  name: string,
  args: string,
  options?: RunOptions,
): Promise<RunResult> {
  return remote.exec(`docker compose -f ${q(servicePath(name))} ${args}`, options);
}

export interface TargetOptions {
  config?: string;
  service?: string;
  host?: string;
  root?: string;
}

export interface Target {
  name: string;
  remote: Remote;
  config?: Config;
}

/**
 * Work out which service a command applies to: from portal.toml if there is
 * one, with --service, --host, and --root taking precedence.
 */
export async function resolveTarget(options: TargetOptions): Promise<Target> {
  const path = options.config ?? CONFIG_FILE;
  let config: Config | undefined;
  if (options.config || existsSync(path)) {
    config = await loadConfig(path);
  }
  const name = options.service ?? config?.name;
  if (!name) {
    throw new ConfigError(
      `no ${CONFIG_FILE} here; pass --service <name> to pick a service`,
    );
  }
  const remote = new Remote(
    options.host ?? config?.host ?? DEFAULT_HOST,
    options.root ?? config?.root ?? DEFAULT_ROOT,
  );
  return { name, remote, config: config?.name === name ? config : undefined };
}

export class DeployError extends Error {}

/**
 * Wait until the service's container is running and stays up: healthy if it
 * has a healthcheck, otherwise running for a few seconds without restarting.
 * On failure, prints the container's recent logs.
 */
export async function waitForService(
  remote: Remote,
  name: string,
  options: { timeout?: number; settle?: number } = {},
): Promise<void> {
  const state = await spin(`waiting for ${name}`, pollService(remote, name, options));
  if (state === undefined) {
    return;
  }
  console.error(dim(`--- last logs for ${name} ---`));
  await remote.exec(`docker logs --tail 40 ${q(name)}`, {
    inherit: true,
    allowFail: true,
  });
  throw new DeployError(`${name} didn't come up (last state: ${state})`);
}

/** Poll the container until it's up, or return the last state it was in. */
async function pollService(
  remote: Remote,
  name: string,
  { timeout = 60, settle = 5 }: { timeout?: number; settle?: number },
): Promise<string | undefined> {
  const deadline = Date.now() + timeout * 1000;
  let firstRestartCount: number | undefined;
  let runningSince: number | undefined;
  let state = "unknown";

  while (Date.now() < deadline) {
    const result = await remote.exec(
      `docker inspect --format '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}} {{.RestartCount}}' ${q(name)}`,
      { allowFail: true },
    );
    const [status = "missing", health = "none", restarts = "0"] = result.stdout
      .trim()
      .split(" ");
    const restartCount = Number(restarts);
    firstRestartCount ??= restartCount;
    state = health === "none" ? status : `${status} (${health})`;

    if (
      ["exited", "dead", "restarting"].includes(status) ||
      health === "unhealthy" ||
      restartCount > firstRestartCount
    ) {
      break;
    }
    if (status === "running" && health === "healthy") {
      return;
    }
    if (status === "running" && health === "none") {
      runningSince ??= Date.now();
      if (Date.now() - runningSince >= settle * 1000) {
        return;
      }
    }
    await Bun.sleep(1000);
  }
  return state;
}

/**
 * Write a Caddy site snippet and reload Caddy. If the new config doesn't
 * validate, the previous snippet is put back. Returns false if nothing changed.
 */
export async function updateSite(
  remote: Remote,
  name: string,
  content: string | undefined,
): Promise<boolean> {
  const path = sitePath(name);
  const previous = await remote.readFile(path);
  if (previous === content) {
    return false;
  }

  if (content === undefined) {
    await remote.removeFile(path);
  } else {
    await remote.writeFile(path, content);
  }

  const validate = await remote.compose(
    `exec -T caddy caddy validate --config ${CADDYFILE} --adapter caddyfile`,
    { allowFail: true },
  );
  if (validate.code !== 0) {
    if (previous === undefined) {
      await remote.removeFile(path);
    } else {
      await remote.writeFile(path, previous);
    }
    throw new DeployError(
      `Caddy rejected the new site config, so it was reverted:\n  ${caddyErrors(validate.stderr) || validate.stderr.trim()}`,
    );
  }

  await remote.compose(
    `exec -T caddy caddy reload --config ${CADDYFILE} --adapter caddyfile`,
  );
  return true;
}

/** Pull the messages out of Caddy's JSON error log lines. */
export function caddyErrors(output: string): string {
  return output
    .split("\n")
    .flatMap((line) => {
      try {
        const entry = JSON.parse(line) as { level?: string; msg?: string };
        return entry.level === "error" && entry.msg ? [entry.msg] : [];
      } catch {
        return /^Error:/.test(line) ? [line] : [];
      }
    })
    .join("\n  ");
}
