import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import {
  BASE_DIGEST_LABEL,
  BASE_IMAGE_LABEL,
  imageRepo,
  NETWORK,
  servicePath,
} from "../compose.ts";
import {
  CONFIG_FILE,
  ConfigError,
  DEFAULT_HOST,
  DEFAULT_ROOT,
  loadConfig,
  type Config,
} from "../config.ts";
import {
  addBaseLabel,
  analyzeBase,
  DockerfileError,
  dockerfilePath,
  labelMatches,
  type BaseAnalysis,
} from "../dockerfile.ts";
import { baseImage, hasPlugin, imageLabel, PLATFORM, refTag } from "../image.ts";
import {
  imageDigest,
  isVersioned,
  listRegistryTags,
  newerVersion,
  newestTag,
  parseVersion,
} from "../registry.ts";
import { q, Remote, run } from "../remote.ts";
import { sitePath } from "../server.ts";
import { cyan, dim, done, green, red, warn, yellow } from "../ui.ts";
import { ACTION_REPO, ACTION_REQUIRED_INPUTS, actionSteps, updateActionRef } from "../workflow.ts";

export interface DoctorOptions {
  config?: string;
  host?: string;
  root?: string;
  /**
   * Add or correct the Dockerfile's base image label, and move CI workflows to
   * the newest release of portal's action
   */
  fix?: boolean;
}

/** Checks are printed as they run; this keeps count of the problems. */
class Report {
  failures = 0;
  warnings = 0;

  section(title: string) {
    console.error(cyan(title));
  }

  ok(message: string) {
    console.error(`  ${green("✓")} ${message}`);
  }

  warn(message: string, hint?: string) {
    this.warnings++;
    console.error(`  ${yellow("!")} ${message}`);
    if (hint) {
      console.error(`    ${dim(hint)}`);
    }
  }

  fail(message: string, hint?: string) {
    this.failures++;
    console.error(`  ${red("✗")} ${message.replaceAll("\n", "\n    ")}`);
    if (hint) {
      console.error(`    ${dim(hint)}`);
    }
  }
}

/**
 * Check that a project's config and Dockerfile are ready to deploy, that the
 * server can take the deploy, and how the deployed service is doing. Without
 * a portal.toml, only the server is checked.
 */
export async function doctor(options: DoctorOptions = {}) {
  const report = new Report();
  const path = options.config ?? CONFIG_FILE;

  report.section(path);
  let config: Config | undefined;
  if (!options.config && !existsSync(path)) {
    report.warn(`no ${CONFIG_FILE} here, so only the server is checked`);
  } else {
    try {
      config = await loadConfig(path);
      report.ok(`valid: ${config.name} (${config.domains.join(", ")})`);
    } catch (err) {
      if (!(err instanceof ConfigError)) {
        throw err;
      }
      report.fail(err.message);
    }
  }

  let analysis: BaseAnalysis | undefined;
  if (config) {
    analysis = await checkDockerfile(report, config, options.fix ?? false);
    if (config.source.kind === "static") {
      checkStaticDir(report, config);
    }
    if (config.source.kind !== "image") {
      await checkLocalDocker(report);
    } else if (isVersioned(config.source.image)) {
      await checkPinnedImage(report, config.source.image);
    }
    await checkWorkflows(report, config, options.fix ?? false);
  }

  const remote = new Remote(
    options.host ?? config?.host ?? DEFAULT_HOST,
    options.root ?? config?.root ?? DEFAULT_ROOT,
  );
  if ((await checkServer(report, remote)) && config) {
    await checkService(report, remote, config, analysis);
  }

  console.error();
  if (report.failures > 0) {
    console.error(
      red(`${report.failures} problem${report.failures === 1 ? "" : "s"} would stop a deploy`),
    );
    process.exitCode = 1;
  } else if (report.warnings > 0) {
    warn(`${report.warnings} warning${report.warnings === 1 ? "" : "s"}, but nothing stops a deploy`);
  } else {
    done("everything looks good");
  }
}

async function checkDockerfile(
  report: Report,
  config: Config,
  fix: boolean,
): Promise<BaseAnalysis | undefined> {
  const path = dockerfilePath(config);
  if (!path) {
    return;
  }
  const name = relative(process.cwd(), path) || path;
  report.section(
    config.source.kind === "image" ? `${name} ${dim("(built outside portal)")}` : name,
  );
  const file = Bun.file(path);
  if (!(await file.exists())) {
    report.fail("doesn't exist");
    return;
  }

  const options =
    config.source.kind === "build"
      ? { target: config.source.target, args: config.source.args }
      : {};
  let text = await file.text();
  let analysis: BaseAnalysis;
  try {
    analysis = analyzeBase(text, options);
    if (fix && analysis.base && !labelMatches(analysis)) {
      text = addBaseLabel(text, options);
      await Bun.write(path, text);
      analysis = analyzeBase(text, options);
      report.ok(`added the ${BASE_IMAGE_LABEL} label`);
    }
  } catch (err) {
    if (!(err instanceof DockerfileError)) {
      throw err;
    }
    report.fail(`${fix ? "couldn't fix: " : ""}${err.message}`);
    return;
  }

  const { base, label, stage } = analysis;
  if (!base) {
    report.ok("builds from scratch, so there's no base image to check");
  } else if (base.missing.length > 0) {
    report.warn(
      `base image ${base.expression} uses ${base.missing.join(", ")}, which has no default`,
    );
  } else if (!isVersioned(base.value) && config.source.kind === "build") {
    report.ok(
      `base image ${base.value} isn't a version, so deploys record its digest to notice when it's rebuilt`,
    );
  } else if (!isVersioned(base.value)) {
    report.warn(
      `base image ${base.value} isn't pinned to a version, so \`portal update\` can't check it for newer versions`,
    );
  } else {
    await checkBaseVersion(report, base.value);
  }

  if (base && base.missing.length === 0) {
    if (labelMatches(analysis)) {
      report.ok(`labels its base image, ${base.value}`);
    } else if (!label) {
      report.warn(
        `doesn't label its base image, so \`portal update\` can't check ${base.value} for newer versions`,
        "run `portal doctor --fix` to add the label",
      );
    } else {
      const undeclared =
        label.missing.length > 0
          ? ` (${label.missing.join(", ")} needs an ARG line in the ${label.stage.name ?? "final"} stage)`
          : "";
      report.warn(
        `its ${BASE_IMAGE_LABEL} label is "${label.value}", but it's built from ${base.value}${undeclared}`,
        "run `portal doctor --fix` to correct the label",
      );
    }
  }

  const exposed = stage.instructions
    .filter((i) => i.keyword === "EXPOSE")
    .flatMap((i) => i.args.split(/\s+/).map((port) => port.replace(/\/\w+$/, "")));
  if (exposed.length > 0 && !exposed.includes(String(config.port))) {
    report.warn(
      `exposes ${exposed.join(", ")}, but ${CONFIG_FILE} sends traffic to port ${config.port}`,
    );
  }
  return analysis;
}

async function checkBaseVersion(report: Report, ref: string) {
  let newer: string | undefined;
  try {
    newer = await newerVersion(ref);
  } catch (err) {
    report.warn(`couldn't check base image ${ref} for newer versions: ${(err as Error).message}`);
    return;
  }
  if (newer) {
    report.warn(
      `base image ${ref} has a newer version, ${newer}`,
      "update the version in the Dockerfile and redeploy",
    );
  } else {
    report.ok(`base image ${ref} is the newest version`);
  }
}

function checkStaticDir(report: Report, config: Config) {
  if (config.source.kind !== "static") {
    return;
  }
  report.section("static site");
  const dir = resolve(config.dir, config.source.dir);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    report.fail(`${config.source.dir} doesn't exist`, "build the site before deploying");
    return;
  }
  report.ok(`serves ${config.source.dir}`);
  const { fallback } = config.source;
  if (fallback && !existsSync(join(dir, fallback))) {
    report.warn(`fallback page ${fallback} isn't in ${config.source.dir}`);
  }
}

async function checkLocalDocker(report: Report) {
  report.section("local docker");
  const info = await run(["docker", "info", "--format", "{{.ServerVersion}}"], {
    allowFail: true,
  });
  if (info.code !== 0) {
    report.fail("docker isn't running, so the image can't be built");
    return;
  }
  report.ok(`docker ${info.stdout.trim()}`);
  if (!(await hasPlugin("buildx"))) {
    report.fail(`docker buildx isn't installed; it's needed to build for ${PLATFORM}`);
  }
}

async function checkPinnedImage(report: Report, ref: string) {
  report.section("image");
  const tag = refTag(ref)!;
  let tags: string[];
  try {
    tags = await listRegistryTags(ref);
  } catch (err) {
    report.warn(`couldn't list ${ref}'s tags: ${(err as Error).message}`);
    return;
  }
  if (!tags.includes(tag)) {
    report.fail(`${ref} doesn't exist in its registry`);
    return;
  }
  const newer = newestTag(tag, tags);
  if (newer) {
    report.warn(`${ref} has a newer version, ${newer}`);
  } else {
    report.ok(`${ref} is the newest version`);
  }
}

/** The repository root holding the project's GitHub workflows, if any. */
function workflowRoot(dir: string): string | undefined {
  for (let current = dir; ; current = dirname(current)) {
    if (existsSync(join(current, ".github", "workflows"))) {
      return current;
    }
    if (existsSync(join(current, ".git")) || dirname(current) === current) {
      return;
    }
  }
}

/** The newest version tag of portal's action on GitHub. */
async function latestActionTag(): Promise<string | undefined> {
  const response = await fetch(
    `https://api.github.com/repos/${ACTION_REPO}/tags?per_page=100`,
    { signal: AbortSignal.timeout(15_000) },
  );
  if (!response.ok) {
    throw new Error(`GitHub returned ${response.status}`);
  }
  const tags = ((await response.json()) as { name: string }[]).map((t) => t.name);
  return newestTag("v0.0.0", tags);
}

/** Check the CI workflows that deploy with portal's action. */
async function checkWorkflows(report: Report, config: Config, fix: boolean) {
  const root = workflowRoot(config.dir);
  if (!root) {
    return;
  }
  const dir = join(root, ".github", "workflows");
  const files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort();
  const workflows = await Promise.all(
    files.map(async (file) => {
      const path = join(dir, file);
      return { path, name: relative(process.cwd(), path), text: await Bun.file(path).text() };
    }),
  );
  const uses = workflows.flatMap(({ name, text }) =>
    actionSteps(text).map((step) => ({ file: name, ...step })),
  );
  if (uses.length === 0) {
    return;
  }

  report.section("CI workflows");
  let latest: string | undefined;
  try {
    latest = await latestActionTag();
  } catch (err) {
    report.warn(`couldn't look up the newest portal action: ${(err as Error).message}`);
  }

  const updated = new Set<string>();
  if (fix && latest) {
    for (const { path, name, text } of workflows) {
      const fixed = updateActionRef(text, latest);
      if (fixed !== text) {
        await Bun.write(path, fixed);
        updated.add(name);
      }
    }
  }

  for (const { file, job, ref, inputs, readsPackages } of uses) {
    const where = `${file} (${job})`;
    if (!parseVersion(ref)) {
      report.warn(
        `${where} uses ${ACTION_REPO}@${ref}, which isn't a release tag`,
        latest ? `pin it to ${latest}` : undefined,
      );
    } else if (latest && newestTag(ref, [latest])) {
      if (updated.has(file)) {
        report.ok(`${where} updated from portal ${ref} to ${latest}`);
      } else {
        report.warn(
          `${where} uses portal ${ref}; ${latest} is the newest`,
          "run `portal doctor --fix` to update it",
        );
      }
    } else {
      report.ok(`${where} uses portal ${ref}`);
    }

    const missing = ACTION_REQUIRED_INPUTS.filter((name) => !(name in inputs));
    if (missing.length > 0) {
      report.fail(`${where} is missing the action's required ${missing.join(", ")} input`);
    }
    const configPath = typeof inputs.config === "string" ? inputs.config : CONFIG_FILE;
    if (!configPath.includes("${{") && !existsSync(join(root, configPath))) {
      report.fail(`${where} deploys ${configPath}, which doesn't exist`);
    }
    if (readsPackages === false && !("registry-token" in inputs)) {
      report.fail(
        `${where} doesn't grant \`packages: read\`, so the server can't pull the image with the job's token`,
      );
    }
  }
}

/** Returns false if the server can't be used, so service checks are skipped. */
async function checkServer(report: Report, remote: Remote): Promise<boolean> {
  report.section(`server ${dim(`(${remote.host}:${remote.root})`)}`);
  const reach = await remote.exec("true", { allowFail: true });
  if (reach.code !== 0) {
    report.fail(
      remote.isLocal
        ? `${remote.root} doesn't exist`
        : `can't reach ${remote.host} over ssh: ${reach.stderr.trim()}`,
    );
    return false;
  }
  const docker = await remote.exec("docker info --format '{{.ServerVersion}}'", {
    allowFail: true,
  });
  if (docker.code !== 0) {
    report.fail(`docker isn't usable: ${docker.stderr.trim()}`);
    return false;
  }
  report.ok(`docker ${docker.stdout.trim()}`);

  const ps = await remote.compose("ps --all --format '{{.Service}}\t{{.State}}'", {
    allowFail: true,
  });
  const states = new Map(
    ps.stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split("\t") as [string, string]),
  );
  for (const service of ["caddy", "cloudflared"]) {
    const state = states.get(service);
    if (state === "running") {
      report.ok(`${service} is running`);
    } else {
      report.fail(`${service} is ${state ?? "missing"}, so deployed services can't be reached`);
    }
  }

  const network = await remote.exec(`docker network inspect ${q(NETWORK)}`, {
    allowFail: true,
  });
  if (network.code !== 0) {
    report.fail(`the ${NETWORK} network doesn't exist, so services can't join it`);
  }
  return true;
}

async function checkService(
  report: Report,
  remote: Remote,
  config: Config,
  analysis: BaseAnalysis | undefined,
) {
  const { name } = config;
  report.section(`service ${name}`);

  // Another site routing one of these domains would make Caddy's config invalid
  const sites = await remote.exec(
    `for f in caddy/sites/*.caddy; do [ -e "$f" ] && printf '%s\\t%s\\n' "$f" "$(head -1 "$f")"; done; true`,
  );
  for (const line of sites.stdout.split("\n").filter(Boolean)) {
    const [file = "", addresses = ""] = line.split("\t");
    if (file === sitePath(name)) {
      continue;
    }
    const routed = addresses
      .replace(/\s*\{\s*$/, "")
      .split(",")
      .map((a) => a.trim().replace(/^https?:\/\//, ""));
    for (const domain of config.domains.filter((d) => routed.includes(d))) {
      report.fail(`${domain} is already routed by ${file}`);
    }
  }

  if (!(await remote.exists(servicePath(name)))) {
    report.ok("not deployed yet");
    return;
  }
  const state = (
    await remote.exec(
      `docker inspect --format '{{.State.Status}}{{if .State.Health}} ({{.State.Health.Status}}){{end}}' ${q(name)}`,
      { allowFail: true },
    )
  ).stdout.trim();
  if (state === "running" || state === "running (healthy)") {
    report.ok(state);
  } else {
    report.warn(`container is ${state || "missing"}`, "see `portal status` and `portal logs`");
  }

  // Pinned images are checked by their own version, and a project without a
  // Dockerfile can't add the labels
  if (config.source.kind !== "static" && !analysis?.base) {
    return;
  }
  const ref = `${imageRepo(name)}:latest`;
  const deployedBase = await baseImage(remote, ref);
  if (!deployedBase) {
    report.warn(
      "deployed image has no base image label",
      config.source.kind === "static" || (analysis && labelMatches(analysis))
        ? "the next deploy adds it"
        : undefined,
    );
    return;
  }
  if (config.source.kind !== "static") {
    report.ok(`deployed image is built from ${deployedBase}`);
  }
  // A base pinned to a digest can't be rebuilt
  if (deployedBase.includes("@")) {
    return;
  }

  const builtElsewhere = config.source.kind === "image";
  const digest = await imageLabel(remote, ref, BASE_DIGEST_LABEL);
  if (!digest) {
    report.warn(
      `deployed image has no ${BASE_DIGEST_LABEL} label, so rebuilds of ${deployedBase} won't be noticed`,
      builtElsewhere
        ? `pass the labels from ${ACTION_REPO}/labels to the CI build (see the README)`
        : "the next deploy adds it",
    );
    return;
  }
  let current: string;
  try {
    current = await imageDigest(deployedBase, PLATFORM);
  } catch (err) {
    report.warn(`couldn't check whether ${deployedBase} was rebuilt: ${(err as Error).message}`);
    return;
  }
  if (current === digest) {
    report.ok(`${deployedBase} hasn't been rebuilt since the deployed image was built`);
  } else {
    report.warn(
      `${deployedBase} has been rebuilt since the deployed image was built`,
      builtElsewhere ? "rerun the CI build to pick it up" : "redeploy to pick it up",
    );
  }
}
