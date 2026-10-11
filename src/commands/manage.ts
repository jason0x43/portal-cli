import { imageRepo, removeInclude, servicePath } from "../compose.ts";
import { formatValue, isValidKey, parseEnv, setVars, unsetVars } from "../dotenv.ts";
import { DEPLOY_TAG_RE } from "../image.ts";
import { q } from "../remote.ts";
import {
  commitServer,
  DeployError,
  envPath,
  ROOT_COMPOSE,
  sitePath,
  updateSite,
  waitForService,
  type Target,
} from "../server.ts";
import { bold, confirm, dim, done, step, warn } from "../ui.ts";

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
  if (assignments.length === 0) {
    throw new DeployError("usage: portal env set KEY=VALUE... (or KEY with the value on stdin)");
  }
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
  await target.remote.compose(`up -d --force-recreate ${q(target.name)}`, {
    inherit: true,
  });
  await waitForService(target.remote, target.name);
  done(`${target.name} is running`);
}

// ---------------------------------------------------------------- status

export async function status(target: Target) {
  const { remote, name } = target;
  if (await isComposeService(target)) {
    await remote.compose(
      `ps -a --format 'table {{.Name}}\\t{{.Status}}\\t{{.RunningFor}}' ${q(name)}`,
      { inherit: true },
    );
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
  await target.remote.compose(
    `logs --tail ${q(tail)}${follow ? " --follow" : ""} ${q(target.name)}`,
    { inherit: true, tty: follow && process.stdout.isTTY },
  );
}

export async function restart(target: Target) {
  await requireComposeService(target);
  step(`restarting ${target.name}`);
  await target.remote.compose(`restart ${q(target.name)}`, { inherit: true });
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
  await target.remote.compose(`up -d --force-recreate ${q(target.name)}`, {
    inherit: true,
  });
  await waitForService(target.remote, target.name);
  done(`${target.name} is running ${repo}:${chosen.tag}`);
}

// ---------------------------------------------------------------- remove

export async function remove(
  target: Target,
  { purge = false, yes = false, commit = true, push = false } = {},
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

  const changed = [sitePath(name)];
  if (hasSite) {
    step("removing Caddy route");
    await updateSite(remote, name, undefined);
  }

  if (isService) {
    step(`stopping ${name}`);
    await remote.compose(`rm --stop --force ${q(name)}`, { inherit: true });
    const root = await remote.readFile(ROOT_COMPOSE);
    const updated = root && removeInclude(root, servicePath(name));
    if (updated !== undefined && updated !== "") {
      await remote.writeFile(ROOT_COMPOSE, updated);
    }
    await remote.removeFile(servicePath(name));
    changed.push(ROOT_COMPOSE, servicePath(name));
    await remote.exec(
      `docker image ls ${q(imageRepo(name))} --format '{{.Repository}}:{{.Tag}}' | xargs -r docker image rm`,
      { allowFail: true },
    );
  }

  if (purge) {
    step("deleting data");
    await remote.exec(`rm -rf ${q(`services/${name}`)}`);
  } else if (isService) {
    await remote.exec(`rmdir ${q(`services/${name}`)} 2>/dev/null || true`);
  }

  if (commit) {
    // Only paths git knows about can be committed as deletions
    const tracked = await remote.exec(
      `git ls-files -- ${changed.map(q).join(" ")} 2>/dev/null || true`,
    );
    const paths = [...new Set([ROOT_COMPOSE, ...tracked.stdout.trim().split("\n").filter(Boolean)])];
    const hash = await commitServer(remote, paths, `Remove ${name}`, { push });
    if (hash) {
      done(`committed server config ${hash}`);
    }
  }
  done(`removed ${name}`);
}
