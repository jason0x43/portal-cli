import { cpSync, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { imageRepo, renderStaticDockerfile } from "./compose.ts";
import { CONFIG_FILE, type Config } from "./config.ts";
import { CommandError, q, run, type Remote } from "./remote.ts";

export const PLATFORM = "linux/amd64";
export const KEEP_IMAGES = 3;

/**
 * Deploy tags start with a UTC timestamp so they sort in deploy order. Image
 * creation times can't be used for that: rebuilding identical content
 * produces an identical image.
 */
export const DEPLOY_TAG_RE = /^\d{8}-\d{6}(-|$)/;

export function deployTag(suffix: string | undefined, now = new Date()): string {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\..*/, "")
    .replace("T", "-");
  return suffix ? `${stamp}-${suffix}` : stamp;
}

/** The git commit being deployed, marked dirty if there are uncommitted changes. */
export async function sourceRevision(dir: string): Promise<string | undefined> {
  const head = await run(["git", "-C", dir, "rev-parse", "--short=12", "HEAD"], {
    allowFail: true,
  });
  if (head.code !== 0) {
    return;
  }
  const status = await run(["git", "-C", dir, "status", "--porcelain"]);
  const sha = head.stdout.trim();
  return status.stdout.trim() ? `${sha}-dirty` : sha;
}

/**
 * Build the image locally for the server's platform. Static sites use a
 * generated Dockerfile with the static directory as the build context.
 */
export async function build(config: Config, tag: string): Promise<void> {
  const repo = imageRepo(config.name);
  const tags = ["--tag", `${repo}:${tag}`, "--tag", `${repo}:latest`];
  const base = ["docker", "buildx", "build", "--platform", PLATFORM, "--load"];

  if (config.source.kind === "static") {
    const siteDir = resolve(config.dir, config.source.dir);
    if (!existsSync(siteDir) || !statSync(siteDir).isDirectory()) {
      throw new Error(`static directory ${siteDir} doesn't exist (did you build it?)`);
    }
    const contextDir = stageStaticSite(siteDir, config.dir, config.source.ignore);
    try {
      writeFileSync(join(contextDir, "Dockerfile"), renderStaticDockerfile(config));
      await run([...base, ...tags, contextDir], { inherit: true });
    } finally {
      rmSync(contextDir, { recursive: true, force: true });
    }
    return;
  }

  if (config.source.kind !== "build") {
    throw new Error("not a build source");
  }
  const { context, dockerfile, target, args } = config.source;
  const contextDir = resolve(config.dir, context);
  await run(
    [
      ...base,
      "--file",
      resolve(contextDir, dockerfile),
      ...(target ? ["--target", target] : []),
      ...Object.entries(args).flatMap(([k, v]) => ["--build-arg", `${k}=${v}`]),
      ...tags,
      contextDir,
    ],
    { inherit: true },
  );
}

/**
 * Build a filter for files to publish from a static site. Always leaves out
 * .git (at any depth) and the project's portal.toml. Extra patterns work like
 * .gitignore: a pattern without a slash matches a file or directory name at
 * any depth; one with a slash matches the path from the site root. Ignoring
 * a directory leaves out everything in it.
 */
export function staticFilter(
  siteDir: string,
  projectDir: string,
  ignore: string[],
): (path: string) => boolean {
  const configPath = resolve(projectDir, CONFIG_FILE);
  const patterns = [".git", ...ignore].map((raw) => {
    const pattern = raw.trim().replace(/\/+$/, "");
    const anchored = pattern.includes("/");
    return { anchored, glob: new Bun.Glob(anchored ? pattern.replace(/^\/+/, "") : pattern) };
  });

  return (path) => {
    const rel = relative(siteDir, path).split(sep).join("/");
    if (rel === "") {
      return true;
    }
    if (resolve(path) === configPath) {
      return false;
    }
    // cpSync filters top-down, so only the entry itself needs checking
    const name = rel.slice(rel.lastIndexOf("/") + 1);
    return !patterns.some(({ anchored, glob }) => glob.match(anchored ? rel : name));
  };
}

/** Copy a static site into a temporary build context, applying staticFilter. */
export function stageStaticSite(
  siteDir: string,
  projectDir: string,
  ignore: string[] = [],
): string {
  const staging = mkdtempSync(join(tmpdir(), "portal-site-"));
  cpSync(siteDir, join(staging, "site"), {
    recursive: true,
    filter: staticFilter(siteDir, projectDir, ignore),
  });
  return staging;
}

/**
 * Copy a local image to the server. Uses `docker pussh` (unregistry), which
 * only sends missing layers, if it's installed; otherwise streams a gzipped
 * `docker save` into `docker load`. Set PORTAL_TRANSFER=load to skip pussh.
 */
export async function transfer(
  remote: Remote,
  ref: string,
  log: (msg: string) => void,
): Promise<void> {
  if (remote.isLocal) {
    // Built by this machine's Docker, which is the server's
    return;
  }
  if (process.env.PORTAL_TRANSFER !== "load" && (await hasPlugin("pussh"))) {
    log("transferring with docker pussh");
    await run(["docker", "pussh", ref, remote.host], { inherit: true });
    return;
  }

  log("transferring with docker save | docker load");
  const save = Bun.spawn(["docker", "save", ref], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const gzipped = save.stdout.pipeThrough(new CompressionStream("gzip"));
  // docker load detects gzip input itself
  const load = remote.exec("docker load", { input: gzipped });
  const [saveCode, saveErr] = await Promise.all([
    save.exited,
    new Response(save.stderr).text(),
  ]);
  if (saveCode !== 0) {
    throw new CommandError(`docker save ${ref}`, saveCode, saveErr);
  }
  await load;
}

/**
 * Pull a prebuilt image on the server, optionally logging in to its registry
 * first. Returns the deploy tag to use for the local portal/<name> image.
 */
export async function pull(
  remote: Remote,
  ref: string,
  login?: { user: string; token: string },
): Promise<string> {
  const registry = registryOf(ref);
  if (login) {
    await remote.exec(
      `docker login ${q(registry)} -u ${q(login.user)} --password-stdin`,
      { input: login.token },
    );
  }
  try {
    await remote.exec(`docker pull ${q(ref)}`, { inherit: true });
  } finally {
    // CI tokens expire with the job, so don't leave them in the server's docker config
    if (login) {
      await remote.exec(`docker logout ${q(registry)}`, { allowFail: true });
    }
  }
  const tag = refTag(ref);
  if (tag && tag !== "latest") {
    return deployTag(tag);
  }
  const id = await remote.exec(
    `docker image inspect --format '{{.Id}}' ${q(ref)}`,
  );
  return deployTag(id.stdout.trim().replace(/^sha256:/, "").slice(0, 12));
}

/** Whether a docker CLI plugin is installed. (`docker <plugin> --help` exits 0 either way.) */
async function hasPlugin(name: string): Promise<boolean> {
  const result = await run(
    ["docker", "info", "--format", "{{range .ClientInfo.Plugins}}{{.Name}}\n{{end}}"],
    { allowFail: true },
  );
  return result.stdout.split("\n").includes(name);
}

/** Point portal/<name>:<tag> and :latest at an image on the server. */
export async function retag(
  remote: Remote,
  name: string,
  from: string,
  tag: string,
): Promise<void> {
  const repo = imageRepo(name);
  const cmds = [`docker tag ${q(from)} ${q(`${repo}:latest`)}`];
  if (from !== `${repo}:${tag}`) {
    cmds.unshift(`docker tag ${q(from)} ${q(`${repo}:${tag}`)}`);
  }
  await remote.exec(cmds.join(" && "));
}

/** Deploy tags of portal/<name> on the server, newest first. */
export async function listTags(remote: Remote, name: string): Promise<string[]> {
  const result = await remote.exec(
    `docker image ls ${q(imageRepo(name))} --format '{{.Tag}}'`,
  );
  return result.stdout
    .split("\n")
    .filter((tag) => DEPLOY_TAG_RE.test(tag))
    .sort()
    .reverse();
}

/** Remove all but the newest KEEP_IMAGES tags of portal/<name>. */
export async function prune(remote: Remote, name: string): Promise<string[]> {
  const stale = (await listTags(remote, name)).slice(KEEP_IMAGES);
  if (stale.length > 0) {
    const refs = stale.map((t) => q(`${imageRepo(name)}:${t}`)).join(" ");
    await remote.exec(`docker image rm ${refs}`, { allowFail: true });
  }
  return stale;
}

export function registryOf(ref: string): string {
  const first = ref.split("/")[0]!;
  return ref.includes("/") && /[.:]|^localhost$/.test(first)
    ? first
    : "docker.io";
}

export function refTag(ref: string): string | undefined {
  const withoutDigest = ref.split("@")[0]!;
  const lastPart = withoutDigest.split("/").at(-1)!;
  return lastPart.includes(":") ? lastPart.split(":")[1] : undefined;
}
