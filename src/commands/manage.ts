import { imageRepo, renderDisabledSite, servicePath } from "../compose.ts";
import { formatValue, isValidKey, parseEnv, setVars, unsetVars } from "../dotenv.ts";
import { DEPLOY_TAG_RE } from "../image.ts";
import { CommandError, q, type Remote } from "../remote.ts";
import {
  DeployError,
  disabledPath,
  envPath,
  isDisabled,
  recreateService,
  serviceCompose,
  sitePath,
  updateSite,
  waitForService,
  type Target,
} from "../server.ts";
import { bold, confirm, dim, done, printTable, step, warn } from "../ui.ts";

async function isComposeService({ remote, name }: Target): Promise<boolean> {
  return remote.exists(servicePath(name));
}

async function requireComposeService(target: Target) {
  if (!(await isComposeService(target))) {
    throw new DeployError(
      `${target.name} has no ${servicePath(target.name)} on ${target.remote.host}`,
    );
  }
}

// ---------------------------------------------------------------- env

export async function envList(target: Target, { show = false } = {}) {
  const text = (await target.remote.readFile(envPath(target.name))) ?? "";
  const vars = parseEnv(text);
  if (vars.size === 0) {
    console.error(dim(`no variables in ${envPath(target.name)}`));
  }
  for (const [key, value] of vars) {
    console.log(show ? `${key}=${value}` : key);
  }
}

/**
 * Set variables from KEY=VALUE arguments. A bare KEY reads its value from
 * stdin, which keeps secrets out of shell history.
 */
export async function envSet(
  target: Target,
  assignments: string[],
  { restart = true } = {},
) {
  if (assignments.length > 1 && assignments.some((a) => !a.includes("="))) {
    throw new DeployError("a value can only be read from stdin when setting one variable");
  }
  const updates: Record<string, string> = {};
  for (const arg of assignments) {
    const eq = arg.indexOf("=");
    const key = eq === -1 ? arg : arg.slice(0, eq);
    if (!isValidKey(key)) {
      throw new DeployError(`invalid variable name ${JSON.stringify(key)}`);
    }
    updates[key] = eq === -1 ? await readValue(key) : arg.slice(eq + 1);
    // Fail before writing anything if a value can't be stored
    formatValue(updates[key]!);
  }

  const path = envPath(target.name);
  const text = (await target.remote.readFile(path)) ?? "";
  await target.remote.writeFile(path, setVars(text, updates), { mode: "600" });
  done(`set ${Object.keys(updates).join(", ")} in ${path}`);
  await applyEnv(target, restart);
}

export async function envUnset(
  target: Target,
  keys: string[],
  { restart = true } = {},
) {
  const path = envPath(target.name);
  const text = await target.remote.readFile(path);
  const present = keys.filter((k) => text && parseEnv(text).has(k));
  if (!text || present.length === 0) {
    warn(`none of ${keys.join(", ")} are set`);
    return;
  }
  await target.remote.writeFile(path, unsetVars(text, present), { mode: "600" });
  done(`removed ${present.join(", ")} from ${path}`);
  await applyEnv(target, restart);
}

async function readValue(key: string): Promise<string> {
  if (process.stdin.isTTY) {
    const value = prompt(`${key}:`);
    if (value === null) {
      throw new DeployError("cancelled");
    }
    return value;
  }
  return (await Bun.stdin.text()).replace(/\r?\n$/, "");
}

async function applyEnv(target: Target, restart: boolean) {
  if (!restart || !(await isComposeService(target))) {
    return;
  }
  // Recreate rather than restart so compose re-reads env_file
  step(`recreating ${target.name} to apply changes`);
  if (await recreateService(target.remote, target.name)) {
    done(`${target.name} is running`);
  } else {
    done(`updated ${target.name}, which is disabled, so it wasn't started`);
  }
}

// ---------------------------------------------------------------- status

export async function status(target: Target) {
  const { remote, name } = target;
  if (await isComposeService(target)) {
    await serviceCompose(
      remote,
      name,
      `ps -a --format 'table {{.Name}}\\t{{.Status}}\\t{{.RunningFor}}'`,
      { inherit: true },
    );
    if (await isDisabled(remote, name)) {
      console.log(`\n${bold("disabled")} ${dim("(`portal enable` starts it)")}`);
    }
    const images = await imageTags(target);
    if (images.length > 0) {
      console.log(`\n${bold("images")} ${dim("(newest first)")}`);
      for (const img of images) {
        console.log(`  ${img.current ? "*" : " "} ${img.tag}  ${dim(img.deployed)}`);
      }
    }
  } else {
    throw new DeployError(`${name} isn't deployed on ${remote.host}`);
  }
  const site = await remote.readFile(sitePath(name));
  console.log(`\n${bold("route")}\n${site ? site.trimEnd() : dim("  none")}`);
}

interface ImageTag {
  tag: string;
  deployed: string;
  current: boolean;
}

/** Deploy tags of portal/<name> newest first, marking the one :latest points at. */
async function imageTags({ remote, name }: Target): Promise<ImageTag[]> {
  const result = await remote.exec(
    `docker image ls ${q(imageRepo(name))} --format '{{.Tag}}\t{{.ID}}'`,
  );
  const rows = result.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => l.split("\t") as [string, string]);
  const latestId = rows.find(([tag]) => tag === "latest")?.[1];
  return rows
    .filter(([tag]) => DEPLOY_TAG_RE.test(tag))
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([tag, id]) => ({
      tag,
      deployed: `${tag.slice(0, 4)}-${tag.slice(4, 6)}-${tag.slice(6, 8)} ${tag.slice(9, 11)}:${tag.slice(11, 13)}:${tag.slice(13, 15)} UTC`,
      current: id === latestId,
    }));
}

// ---------------------------------------------------------------- logs / restart

export async function logs(
  target: Target,
  { follow = false, tail = "100" }: { follow?: boolean; tail?: string } = {},
) {
  await requireComposeService(target);
  const command = `logs --tail ${q(tail)}${follow ? " --follow" : ""}`;
  const result = await serviceCompose(target.remote, target.name, command, {
    inherit: true,
    tty: follow && process.stdout.isTTY,
    allowFail: true,
  });
  // 130 is docker compose exiting on SIGINT: Ctrl-C is how --follow ends
  if (result.code !== 0 && !(follow && result.code === 130)) {
    throw new CommandError(`docker compose ${command}`, result.code, "");
  }
}

export async function restart(target: Target) {
  await requireComposeService(target);
  if (await isDisabled(target.remote, target.name)) {
    throw new DeployError(`${target.name} is disabled; \`portal enable\` starts it`);
  }
  step(`restarting ${target.name}`);
  await serviceCompose(target.remote, target.name, "restart", { inherit: true });
  await waitForService(target.remote, target.name);
  done(`${target.name} is running`);
}

// ---------------------------------------------------------------- rollback

export async function rollback(target: Target, tag?: string) {
  await requireComposeService(target);
  const tags = await imageTags(target);
  const currentIndex = tags.findIndex((t) => t.current);
  const chosen = tag
    ? tags.find((t) => t.tag === tag)
    : tags.slice(currentIndex + 1).find((t) => !t.current);
  if (!chosen) {
    const available = tags.map((t) => t.tag).join(", ") || "none";
    throw new DeployError(
      tag
        ? `no image tagged ${tag} (available: ${available})`
        : `no older image to roll back to (available: ${available})`,
    );
  }

  const repo = imageRepo(target.name);
  step(`switching ${target.name} to ${chosen.tag}`);
  await target.remote.exec(`docker tag ${q(`${repo}:${chosen.tag}`)} ${q(`${repo}:latest`)}`);
  if (await recreateService(target.remote, target.name)) {
    done(`${target.name} is running ${repo}:${chosen.tag}`);
  } else {
    done(`switched ${target.name} to ${repo}:${chosen.tag}; it's disabled, so it wasn't started`);
  }
}

// ---------------------------------------------------------------- enable / disable

/**
 * Stop the service and keep it stopped until `enable`, through reboots and
 * deploys. Its domains answer with a 503 meanwhile.
 */
export async function disable(target: Target) {
  await requireComposeService(target);
  const { remote, name } = target;
  if (await isDisabled(remote, name)) {
    warn(`${name} is already disabled`);
    return;
  }
  // Mark it first, so a deploy that runs meanwhile doesn't start it again
  const route = await remote.readFile(sitePath(name));
  await remote.writeFile(disabledPath(name), route ?? "");
  step(`stopping ${name}`);
  // Stopped rather than removed, so its logs are kept. With restart:
  // unless-stopped, Docker leaves it stopped when the daemon restarts.
  await serviceCompose(remote, name, "stop", { inherit: true });
  if (route) {
    await updateSite(remote, name, renderDisabledSite(route));
  }
  done(`disabled ${name}${route ? "; its domains respond with 503" : ""}`);
}

export async function enable(target: Target) {
  await requireComposeService(target);
  const { remote, name } = target;
  const route = await remote.readFile(disabledPath(name));
  if (route === undefined) {
    warn(`${name} isn't disabled`);
    return;
  }
  step(`starting ${name}`);
  try {
    await serviceCompose(remote, name, "up -d", { inherit: true });
    await waitForService(remote, name);
  } catch (err) {
    // Leave it disabled rather than restarting in a loop
    await serviceCompose(remote, name, "stop", { allowFail: true });
    throw err;
  }
  if (route) {
    await updateSite(remote, name, route);
  }
  await remote.removeFile(disabledPath(name));
  done(`enabled ${name}`);
}

// ---------------------------------------------------------------- remove

export async function remove(
  target: Target,
  { purge = false, yes = false } = {},
) {
  const { remote, name } = target;
  const isService = await isComposeService(target);
  const hasSite = await remote.exists(sitePath(name));
  if (!isService && !hasSite) {
    throw new DeployError(`${name} isn't deployed on ${remote.host}`);
  }

  const kept = purge
    ? "including its data"
    : `keeping services/${name}/data and .env`;
  if (!yes && !confirm(`Remove ${bold(name)} from ${remote.host}, ${kept}?`)) {
    throw new DeployError("cancelled (pass --yes to skip this prompt)");
  }

  if (hasSite) {
    step("removing Caddy route");
    await updateSite(remote, name, undefined);
  }

  if (isService) {
    step(`stopping ${name}`);
    await serviceCompose(remote, name, "down", { inherit: true });
    await remote.removeFile(servicePath(name));
    await remote.exec(
      `docker image ls ${q(imageRepo(name))} --format '{{.Repository}}:{{.Tag}}' | xargs -r docker image rm`,
      { allowFail: true },
    );
  }

  if (purge) {
    step("deleting data");
    await remote.exec(`rm -rf ${q(`services/${name}`)}`);
  } else if (isService) {
    await remote.removeFile(disabledPath(name));
    await remote.exec(`rmdir ${q(`services/${name}`)} 2>/dev/null || true`);
  }
  done(`removed ${name}`);
}

// ---------------------------------------------------------------- list

interface ServiceSummary {
  name: string;
  state: string;
  tag?: string;
  route?: string;
}

/**
 * Every service on the server, with its state, deployed tag, and route.
 */
export async function list(remote: Remote) {
  const result = await remote.exec(
    [
      "for f in services/*/compose.yaml; do",
      '  [ -e "$f" ] || continue',
      '  n=${f#services/}; n=${n%/compose.yaml}',
      `  if [ -e "services/$n/disabled" ]; then s=disabled; else s=$(docker inspect --format '{{.State.Status}}{{if .State.Health}} ({{.State.Health.Status}}){{end}}' "$n" 2>/dev/null || echo missing); fi`,
      `  printf 'S\\t%s\\t%s\\n' "$n" "$s"`,
      `  docker image ls "portal/$n" --format "I\\t$n\\t{{.Tag}}\\t{{.ID}}"`,
      `  [ -f "caddy/sites/$n.caddy" ] && printf 'R\\t%s\\t%s\\n' "$n" "$(head -1 "caddy/sites/$n.caddy" | sed 's/ *{$//; s|http://||g')"`,
      "done; true",
    ].join("\n"),
  );

  const services = new Map<string, ServiceSummary>();
  const images = new Map<string, [string, string][]>();
  for (const line of result.stdout.split("\n")) {
    const [kind, name, a = "", b = ""] = line.split("\t");
    if (!name) {
      continue;
    }
    if (kind === "S") {
      services.set(name, { name, state: a });
    } else if (kind === "I") {
      images.set(name, [...(images.get(name) ?? []), [a, b]]);
    } else if (kind === "R" && services.has(name)) {
      services.get(name)!.route = a;
    }
  }
  for (const [name, rows] of images) {
    const latestId = rows.find(([tag]) => tag === "latest")?.[1];
    const service = services.get(name);
    if (service && latestId) {
      service.tag = rows
        .filter(([tag, id]) => id === latestId && DEPLOY_TAG_RE.test(tag))
        .map(([tag]) => tag)
        .sort()
        .at(-1);
    }
  }

  if (services.size === 0) {
    console.error(dim(`no services on ${remote.host}`));
    return;
  }
  const rows = [...services.values()].map((s) => [
    s.name,
    s.state,
    s.route ?? "-",
    s.tag ?? "-",
  ]);
  printTable(["SERVICE", "STATE", "ROUTE", "IMAGE"], rows);
}
