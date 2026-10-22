import {
  BASE_DIGEST_LABEL,
  BASE_IMAGE_LABEL,
  IMAGE_LABEL,
  STATIC_SERVER_IMAGE,
} from "./compose.ts";
import type { Config } from "./config.ts";
import { analyzeBase, dockerfilePath, DockerfileError, labelMatches } from "./dockerfile.ts";
import { DEPLOY_TAG_RE, deployedAt, PLATFORM, refTag } from "./image.ts";
import { imageDigest, imageName, isVersioned, newerVersion } from "./registry.ts";
import type { Remote } from "./remote.ts";

/** A deployed service's image, as its labels describe it. */
export interface ServiceImage {
  name: string;
  /**
   * Days since portal/<name>:latest was deployed; NaN if there's no image.
   * Deploy tags are used when there are any, since a fully cached rebuild
   * keeps the creation time of the image it replaced.
   */
  days: number;
  /** The image an `image` service deploys, from the container's portal.image label */
  source?: string;
  /** The image it was built from, from the image's base.name label */
  base?: string;
  /** The digest of that image when it was built, from the base.digest label */
  baseDigest?: string;
}

/** Every service on the server and what its labels say about its image. */
export async function serviceImages(remote: Remote): Promise<ServiceImage[]> {
  const result = await remote.exec(
    [
      "for f in services/*/compose.yaml; do",
      '  [ -e "$f" ] || continue',
      '  n=${f#services/}; n=${n%/compose.yaml}',
      `  id=$(docker image inspect --format '{{.Id}}' "portal/$n:latest" 2>/dev/null)`,
      `  tags=$(docker image ls --no-trunc "portal/$n" --format '{{.ID}} {{.Tag}}' | grep "^$id " | cut -d' ' -f2 | tr '\\n' ' ')`,
      `  printf '%s\\t%s\\t%s\\t%s\\t%s\\n' "$n" "$(docker image inspect --format '{{.Created}}' "portal/$n:latest" 2>/dev/null)" "$tags" "$(docker inspect --format '{{index .Config.Labels "${IMAGE_LABEL}"}}' "$n" 2>/dev/null)" "$(docker image inspect --format '{{index .Config.Labels "${BASE_IMAGE_LABEL}"}}\t{{index .Config.Labels "${BASE_DIGEST_LABEL}"}}' "portal/$n:latest" 2>/dev/null)"`,
      "done; true",
    ].join("\n"),
  );
  const now = Date.now();
  return result.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [name = "", created = "", tags = "", source = "", base = "", baseDigest = ""] =
        line.split("\t");
      const newest = tags
        .split(" ")
        .filter((tag) => DEPLOY_TAG_RE.test(tag))
        .sort()
        .at(-1);
      // Docker reports nanoseconds; Date.parse only needs milliseconds
      const at =
        (newest ? deployedAt(newest)?.getTime() : undefined) ??
        Date.parse(created.replace(/(\.\d{3})\d*/, "$1"));
      return {
        name,
        days: Math.floor((now - at) / 86_400_000),
        source: source || undefined,
        base: base || undefined,
        baseDigest: baseDigest || undefined,
      };
    });
}

export interface VersionCheck {
  /** A pinned `image` service, or the base image a built image names */
  kind: "pin" | "base";
  ref: string;
  /** The digest the image was built from, for a base with a base.digest label */
  digest?: string;
  /** The newest version, if it's newer than `ref` */
  newer?: string;
  /** Whether `ref` now points to a different image than `digest` */
  rebuilt?: boolean;
  /** Why the registry couldn't be asked */
  error?: string;
}

/** Whether a service is pinned to a versioned image. */
export function isPinned(image: ServiceImage): boolean {
  return image.source !== undefined && isVersioned(image.source);
}

/** Whether a check found a newer version or a rebuilt tag. */
export function isOutdated(check: VersionCheck): boolean {
  return check.newer !== undefined || check.rebuilt === true;
}

/**
 * What a service can be checked against: a versioned pin, and a base image
 * that's versioned or has a recorded digest.
 */
export function versionChecks(image: ServiceImage): VersionCheck[] {
  const { base, baseDigest } = image;
  return [
    ...(isPinned(image) ? [{ kind: "pin" as const, ref: image.source! }] : []),
    ...(base && (isVersioned(base) || baseDigest)
      ? [{ kind: "base" as const, ref: base, ...(baseDigest ? { digest: baseDigest } : {}) }]
      : []),
  ];
}

/**
 * Ask registries for newer versions of each service's pinned image and base
 * image, and whether a base's tag has been rebuilt since the service's image
 * was built from it. Static sites share a base image, so each image is asked
 * about once.
 */
export async function checkVersions(
  images: ServiceImage[],
): Promise<Map<string, VersionCheck[]>> {
  const cached = <T>(lookup: (ref: string) => Promise<T>) => {
    const lookups = new Map<string, Promise<T>>();
    return (ref: string) => {
      if (!lookups.has(ref)) {
        lookups.set(ref, lookup(ref));
      }
      return lookups.get(ref)!;
    };
  };
  const newerOf = cached(newerVersion);
  const digestOf = cached((ref) => imageDigest(ref, PLATFORM));

  const check = async (c: VersionCheck): Promise<VersionCheck> => {
    try {
      const [newer, digest] = await Promise.all([
        newerOf(c.ref),
        c.digest ? digestOf(c.ref) : undefined,
      ]);
      return { ...c, newer, ...(digest ? { rebuilt: digest !== c.digest } : {}) };
    } catch (err) {
      return { ...c, error: (err as Error).message };
    }
  };
  const entries = await Promise.all(
    images.map(
      async (image): Promise<[string, VersionCheck[]]> => [
        image.name,
        await Promise.all(versionChecks(image).map(check)),
      ],
    ),
  );
  return new Map(entries);
}

/**
 * A check as the version it's on, and what's changed if anything, e.g.
 * "node 26.1.0-slim → 26.12.1-slim", "debian trixie-slim (rebuilt upstream)"
 * or "pinned 18.23.0".
 */
export function describeCheck({ kind, ref, newer, rebuilt }: VersionCheck): string {
  const tag = refTag(ref) ?? "latest";
  const current = kind === "pin" ? `pinned ${tag}` : `${imageName(ref)} ${tag}`;
  if (newer) {
    return `${current} → ${newer}`;
  }
  return rebuilt ? `${current} (rebuilt upstream)` : current;
}

/** What `portal ls --outdated` shows for a service's image. */
export function outdatedSummary(image: ServiceImage, checks: VersionCheck[]): string {
  if (checks.length > 0) {
    // Pinned services also check the base their image names, but only an
    // outdated one is worth showing: the pin is what gets changed
    const shown = isPinned(image)
      ? checks.filter((c) => c.kind === "pin" || isOutdated(c))
      : checks;
    return shown
      .map((c) => (c.error ? `${describeCheck(c)} (couldn't check)` : describeCheck(c)))
      .join(", ");
  }
  if (image.base) {
    return `${image.base} (no version or digest)`;
  }
  if (image.source || !Number.isNaN(image.days)) {
    return "unlabeled";
  }
  return "-";
}

export interface BaseDigestLabels {
  labels: Record<string, string>;
  /** Why there's no digest label */
  problem?: string;
  /** Whether that's because the Dockerfile doesn't label its base image */
  unlabeled?: boolean;
}

/**
 * A label with the digest of the image a build of the service starts from,
 * so `portal update` and `portal ls --outdated` can tell when its tag is
 * rebuilt. Only a base the image names in its base.name label is looked up.
 */
export async function baseDigestLabels(config: Config): Promise<BaseDigestLabels> {
  let ref: string;
  if (config.source.kind === "static") {
    ref = STATIC_SERVER_IMAGE;
  } else {
    const path = dockerfilePath(config);
    if (!path || !(await Bun.file(path).exists())) {
      return { labels: {}, problem: "there's no Dockerfile to find the base image in" };
    }
    const options =
      config.source.kind === "build"
        ? { target: config.source.target, args: config.source.args }
        : {};
    try {
      const analysis = analyzeBase(await Bun.file(path).text(), options);
      if (!analysis.base) {
        return { labels: {} };
      }
      if (!labelMatches(analysis)) {
        return {
          labels: {},
          problem: `the Dockerfile doesn't label its base image, so its digest isn't recorded (run \`portal doctor --fix\` to add the label)`,
          unlabeled: true,
        };
      }
      ref = analysis.base.value;
    } catch (err) {
      if (!(err instanceof DockerfileError)) {
        throw err;
      }
      return { labels: {}, problem: `the Dockerfile ${err.message}` };
    }
  }
  // A base pinned to a digest can't be rebuilt
  if (ref.includes("@")) {
    return { labels: {} };
  }
  try {
    return { labels: { [BASE_DIGEST_LABEL]: await imageDigest(ref, PLATFORM) } };
  } catch (err) {
    return {
      labels: {},
      problem: `couldn't look up ${ref}'s digest, so rebuilds of it won't be noticed: ${(err as Error).message}`,
    };
  }
}
