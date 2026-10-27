import { refTag, registryOf } from "./image.ts";

/** Most tag list pages to follow before giving up on a repository. */
const MAX_PAGES = 50;

/**
 * A version-like tag, e.g. v18.2.0-alpine → prefix "v", numbers [18, 2, 0],
 * suffix "-alpine". Only tags with the same prefix, suffix and number of
 * parts are compared, so a pin on 2.11 isn't offered 2.11.1 and a pin on
 * 1.2.3 isn't offered 1.3.0-rc1.
 */
interface Version {
  prefix: string;
  numbers: number[];
  suffix: string;
}

export function parseVersion(tag: string): Version | undefined {
  const match = /^(v?)(\d+(?:\.\d+){0,3})(-[\w.-]+)?$/.exec(tag);
  if (!match) {
    return;
  }
  return {
    prefix: match[1]!,
    numbers: match[2]!.split(".").map(Number),
    suffix: match[3] ?? "",
  };
}

function compareNumbers(a: number[], b: number[]): number {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return a[i]! - b[i]!;
    }
  }
  return 0;
}

/** The highest tag in `tags` that's newer than `current` and shaped like it. */
export function newestTag(current: string, tags: string[]): string | undefined {
  const pinned = parseVersion(current);
  if (!pinned) {
    return;
  }
  let best: { tag: string; numbers: number[] } | undefined;
  for (const tag of tags) {
    const version = parseVersion(tag);
    if (
      version &&
      version.prefix === pinned.prefix &&
      version.suffix === pinned.suffix &&
      version.numbers.length === pinned.numbers.length &&
      compareNumbers(version.numbers, best?.numbers ?? pinned.numbers) > 0
    ) {
      best = { tag, numbers: version.numbers };
    }
  }
  return best?.tag;
}

/** An image reference without its tag or digest, e.g. node:26-slim → node. */
export function imageName(ref: string): string {
  const name = ref.split("@")[0]!;
  const tagAt = name.lastIndexOf(":");
  return tagAt > name.lastIndexOf("/") ? name.slice(0, tagAt) : name;
}

/** Registry host and repository path for an image reference. */
export function repositoryOf(ref: string): { host: string; repository: string } {
  const untagged = imageName(ref);
  const registry = registryOf(ref);
  let repository = untagged.startsWith(`${registry}/`)
    ? untagged.slice(registry.length + 1)
    : untagged;
  if (registry === "docker.io" && !repository.includes("/")) {
    repository = `library/${repository}`;
  }
  return {
    host: registry === "docker.io" ? "registry-1.docker.io" : registry,
    repository,
  };
}

/**
 * Get an anonymous token for the scope a registry asked for in its
 * WWW-Authenticate challenge. Private repositories will still refuse it.
 */
async function anonymousToken(challenge: string | null): Promise<string> {
  const params = Object.fromEntries(
    [...(challenge ?? "").matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1]!, m[2]!]),
  );
  if (!challenge?.startsWith("Bearer") || !params.realm) {
    throw new Error("registry requires credentials");
  }
  const url = new URL(params.realm);
  for (const key of ["service", "scope"]) {
    if (params[key]) {
      url.searchParams.set(key, params[key]);
    }
  }
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) {
    throw new Error(`token request failed (${response.status})`);
  }
  const body = (await response.json()) as { token?: string; access_token?: string };
  const token = body.token ?? body.access_token;
  if (!token) {
    throw new Error("registry returned no token");
  }
  return token;
}

/**
 * A GET (or HEAD) for an image's repository, which takes a path under the
 * repository or a full URL. It gets an anonymous token if the registry asks
 * for one.
 */
function repositoryFetch(ref: string) {
  const { host, repository } = repositoryOf(ref);
  let token: string | undefined;
  return async (
    path: string,
    headers: Record<string, string> = {},
    method = "GET",
  ): Promise<Response> => {
    const url = /^https:/.test(path) ? path : `https://${host}/v2/${repository}/${path}`;
    const get = (): Promise<Response> =>
      fetch(url, {
        method,
        headers: token ? { ...headers, Authorization: `Bearer ${token}` } : headers,
        signal: AbortSignal.timeout(15_000),
      });
    let response = await get();
    if (response.status === 401 && !token) {
      token = await anonymousToken(response.headers.get("www-authenticate"));
      response = await get();
    }
    if (!response.ok) {
      throw new Error(`${host} returned ${response.status}`);
    }
    return response;
  };
}

/** Every tag in the image's repository, following the registry's pagination. */
export async function listRegistryTags(ref: string): Promise<string[]> {
  const get = repositoryFetch(ref);
  const tags: string[] = [];
  let url: string | undefined = "tags/list?n=1000";
  for (let page = 0; url && page < MAX_PAGES; page++) {
    const response = await get(url);
    const body = (await response.json()) as { tags?: string[] | null };
    tags.push(...(body.tags ?? []));
    const next = /<([^>]+)>;\s*rel="next"/.exec(response.headers.get("link") ?? "")?.[1];
    url = next ? new URL(next, response.url).href : undefined;
  }
  return tags;
}

const MANIFEST_TYPES = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
];

interface ManifestList {
  manifests?: { digest: string; platform?: { os: string; architecture: string } }[];
}

/**
 * The digest of the image a tag points to for `platform` (e.g. linux/amd64):
 * the platform's entry in a multi-platform index, or the manifest itself for
 * a single-platform image. An index's own digest changes whenever any
 * platform is rebuilt, so it isn't used.
 */
export async function imageDigest(ref: string, platform: string): Promise<string> {
  const [os, architecture] = platform.split("/");
  const response = await repositoryFetch(ref)(`manifests/${refTag(ref) ?? "latest"}`, {
    Accept: MANIFEST_TYPES.join(", "),
  });
  const body = (await response.json()) as ManifestList;
  if (body.manifests) {
    const entry = body.manifests.find(
      (m) => m.platform?.os === os && m.platform?.architecture === architecture,
    );
    if (!entry) {
      throw new Error(`${imageName(ref)} has no ${platform} image`);
    }
    return entry.digest;
  }
  const digest = response.headers.get("docker-content-digest");
  if (!digest) {
    throw new Error("registry returned no digest");
  }
  return digest;
}

/**
 * The digest a tag points to as a whole, which is what `docker pull` records
 * in an image's RepoDigests. It's a HEAD request, which Docker Hub doesn't
 * count against its pull rate limit.
 */
export async function manifestDigest(ref: string): Promise<string> {
  return tagDigest(repositoryFetch(ref), refTag(ref) ?? "latest");
}

async function tagDigest(
  get: ReturnType<typeof repositoryFetch>,
  tag: string,
): Promise<string> {
  const response = await get(
    `manifests/${tag}`,
    { Accept: MANIFEST_TYPES.join(", ") },
    "HEAD",
  );
  const digest = response.headers.get("docker-content-digest");
  if (!digest) {
    throw new Error("registry returned no digest");
  }
  return digest;
}

/**
 * Tags that could be the specific version a moving tag points to, most
 * specific and newest first: for 2.11, tags like 2.11.7; for latest or
 * another unversioned tag, any version without a suffix.
 */
export function versionCandidates(tag: string, tags: string[]): string[] {
  const moving = parseVersion(tag);
  return tags
    .map((t) => ({ tag: t, version: parseVersion(t) }))
    .filter(
      (c): c is { tag: string; version: Version } =>
        c.version !== undefined &&
        (moving
          ? c.version.prefix === moving.prefix &&
            c.version.suffix === moving.suffix &&
            c.version.numbers.length > moving.numbers.length &&
            compareNumbers(moving.numbers, c.version.numbers) === 0
          : c.version.suffix === ""),
    )
    .sort(
      (a, b) =>
        b.version.numbers.length - a.version.numbers.length ||
        compareNumbers(b.version.numbers, a.version.numbers),
    )
    .map((c) => c.tag);
}

/** How many candidate tags to ask about before giving up on naming a version. */
const MAX_VERSION_LOOKUPS = 20;

/**
 * The version tag that points to the same image as `digest` (a digest
 * `manifestDigest` returns for `ref`), e.g. 2.11.7 for an image pulled as
 * caddy:2.11. Undefined if it's not one of the newest few versions.
 */
export async function versionOf(
  ref: string,
  digest: string,
  tags: string[],
): Promise<string | undefined> {
  const tag = refTag(ref) ?? "latest";
  if (parseVersion(tag) && !versionCandidates(tag, tags).length) {
    return tag;
  }
  const get = repositoryFetch(ref);
  for (const candidate of versionCandidates(tag, tags).slice(0, MAX_VERSION_LOOKUPS)) {
    if ((await tagDigest(get, candidate)) === digest) {
      return candidate;
    }
  }
}

/** Whether an image reference is pinned to a version tag that can be checked. */
export function isVersioned(ref: string): boolean {
  return parseVersion(refTag(ref) ?? "") !== undefined;
}

/** A newer version of a pinned image, if its registry has one. */
export async function newerVersion(ref: string): Promise<string | undefined> {
  const current = refTag(ref);
  if (!current || !parseVersion(current)) {
    return;
  }
  return newestTag(current, await listRegistryTags(ref));
}
