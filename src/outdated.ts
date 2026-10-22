import { BASE_IMAGE_LABEL, IMAGE_LABEL } from "./compose.ts";
import { refTag } from "./image.ts";
import { imageName, isVersioned, newerVersion } from "./registry.ts";
import type { Remote } from "./remote.ts";

/** A deployed service's image, as its labels describe it. */
export interface ServiceImage {
  name: string;
  /** Days since portal/<name>:latest was created; NaN if there's no image */
  days: number;
  /** The image an `image` service deploys, from the container's portal.image label */
  source?: string;
  /** The image it was built from, from the image's base.name label */
  base?: string;
}

/** Every service on the server and what its labels say about its image. */
export async function serviceImages(remote: Remote): Promise<ServiceImage[]> {
  const result = await remote.exec(
    [
      "for f in services/*/compose.yaml; do",
      '  [ -e "$f" ] || continue',
      '  n=${f#services/}; n=${n%/compose.yaml}',
      `  printf '%s\\t%s\\t%s\\t%s\\n' "$n" "$(docker image inspect --format '{{.Created}}' "portal/$n:latest" 2>/dev/null)" "$(docker inspect --format '{{index .Config.Labels "${IMAGE_LABEL}"}}' "$n" 2>/dev/null)" "$(docker image inspect --format '{{index .Config.Labels "${BASE_IMAGE_LABEL}"}}' "portal/$n:latest" 2>/dev/null)"`,
      "done; true",
    ].join("\n"),
  );
  const now = Date.now();
  return result.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [name = "", created = "", source = "", base = ""] = line.split("\t");
      // Docker reports nanoseconds; Date.parse only needs milliseconds
      const createdAt = Date.parse(created.replace(/(\.\d{3})\d*/, "$1"));
      return {
        name,
        days: Math.floor((now - createdAt) / 86_400_000),
        source: source || undefined,
        base: base || undefined,
      };
    });
}

export interface VersionCheck {
  /** A pinned `image` service, or the base image a built image names */
  kind: "pin" | "base";
  ref: string;
  /** The newest version, if it's newer than `ref` */
  newer?: string;
  /** Why the registry couldn't be asked */
  error?: string;
}

/** Whether a service is pinned to a versioned image. */
export function isPinned(image: ServiceImage): boolean {
  return image.source !== undefined && isVersioned(image.source);
}

/** The versioned images a service can be checked against. */
export function versionChecks(image: ServiceImage): VersionCheck[] {
  return [
    ...(isPinned(image) ? [{ kind: "pin" as const, ref: image.source! }] : []),
    ...(image.base && isVersioned(image.base) ? [{ kind: "base" as const, ref: image.base }] : []),
  ];
}

/**
 * Ask registries for newer versions of each service's pinned image and base
 * image. Static sites share a base image, so each image is asked about once.
 */
export async function checkVersions(
  images: ServiceImage[],
): Promise<Map<string, VersionCheck[]>> {
  const lookups = new Map<string, Promise<string | undefined>>();
  const lookup = (ref: string) => {
    if (!lookups.has(ref)) {
      lookups.set(ref, newerVersion(ref));
    }
    return lookups.get(ref)!;
  };
  const entries = await Promise.all(
    images.map(
      async (image): Promise<[string, VersionCheck[]]> => [
        image.name,
        await Promise.all(
          versionChecks(image).map((check) =>
            lookup(check.ref).then(
              (newer) => ({ ...check, newer }),
              (err: unknown) => ({ ...check, error: (err as Error).message }),
            ),
          ),
        ),
      ],
    ),
  );
  return new Map(entries);
}

/**
 * A check as the version it's on, and the newer one if there is one, e.g.
 * "node 26.1.0-slim → 26.12.1-slim" or "pinned 18.23.0".
 */
export function describeCheck({ kind, ref, newer }: VersionCheck): string {
  const current = kind === "pin" ? `pinned ${refTag(ref)}` : `${imageName(ref)} ${refTag(ref)}`;
  return newer ? `${current} → ${newer}` : current;
}

/** What `portal ls --outdated` shows for a service's image. */
export function outdatedSummary(image: ServiceImage, checks: VersionCheck[]): string {
  if (checks.length > 0) {
    // Pinned services also check the base their image names, but only a newer
    // one is worth showing: the pin is what gets changed
    const shown = isPinned(image)
      ? checks.filter((c) => c.kind === "pin" || c.newer)
      : checks;
    return shown
      .map((c) => (c.error ? `${describeCheck(c)} (couldn't check)` : describeCheck(c)))
      .join(", ");
  }
  if (image.base) {
    return `${image.base} (not a version)`;
  }
  if (image.source || !Number.isNaN(image.days)) {
    return "unlabeled";
  }
  return "-";
}
