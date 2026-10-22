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

/** Every tag in the image's repository, following the registry's pagination. */
export async function listRegistryTags(ref: string): Promise<string[]> {
  const { host, repository } = repositoryOf(ref);
  const tags: string[] = [];
  let token: string | undefined;
  let url: string | undefined = `https://${host}/v2/${repository}/tags/list?n=1000`;
  for (let page = 0; url && page < MAX_PAGES; page++) {
    const get = (): Promise<Response> =>
      fetch(url!, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
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
    const body = (await response.json()) as { tags?: string[] | null };
    tags.push(...(body.tags ?? []));
    const next = /<([^>]+)>;\s*rel="next"/.exec(response.headers.get("link") ?? "")?.[1];
    url = next ? new URL(next, url).href : undefined;
  }
  return tags;
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
