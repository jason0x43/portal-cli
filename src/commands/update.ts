import {
  checkVersions,
  describeCheck,
  isOutdated,
  isPinned,
  serviceImages,
  uncheckedReason,
  upgradeRows,
  type VersionCheck,
} from "../outdated.ts";
import {
  imageDigest,
  imageName,
  listRegistryTags,
  manifestDigest,
  newestTag,
  versionOf,
} from "../registry.ts";
import { PLATFORM, refTag } from "../image.ts";
import { q, type Remote } from "../remote.ts";
import { DeployError, waitForService } from "../server.ts";
import { bold, dim, done, printTable, spin, step, warn } from "../ui.ts";

/** Service images older than this get a reminder to redeploy them. */
export const STALE_IMAGE_DAYS = 30;
/** How long routes get to match their pre-update status after recreating. */
const ROUTE_SETTLE_SECONDS = 60;

interface InfraContainer {
  service: string;
  container: string;
  /** Image reference from the compose file, e.g. caddy:2.11 */
  ref: string;
  /** Image the container is running */
  imageId: string;
  /**
   * The platform manifest it's running, with the containerd image store,
   * where `imageId` is the multi-platform index
   */
  manifest?: string;
}

/** `ref` with a suffix added to its tag, e.g. caddy:2.11 → caddy:2.11-previous */
function suffixedRef(ref: string, suffix: string): string {
  const lastPart = ref.slice(ref.lastIndexOf("/") + 1);
  return lastPart.includes(":") ? `${ref}-${suffix}` : `${ref}:latest-${suffix}`;
}

/** The local tag that keeps the image an update replaced, for rollback. */
export const previousRef = (ref: string) => suffixedRef(ref, "previous");

/**
 * A temporary tag holding the running image during an update. It has to be
 * set before pulling: with Docker's containerd image store, once a pull moves
 * the tag, the old image can no longer be addressed by its ID.
 */
const holdRef = (ref: string) => suffixedRef(ref, "pre-update");

/** Containers in the root (infrastructure) project and the images they run. */
async function infraContainers(remote: Remote): Promise<InfraContainer[]> {
  const result = await remote.exec(
    `docker compose ps -q | xargs -r docker inspect --format '{{index .Config.Labels "com.docker.compose.service"}}\t{{.Name}}\t{{.Config.Image}}\t{{.Image}}\t{{with .ImageManifestDescriptor}}{{.Digest}}{{end}}'`,
  );
  return result.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [service = "", name = "", ref = "", imageId = "", manifest = ""] = line.split("\t");
      return {
        service,
        container: name.replace(/^\//, ""),
        ref,
        imageId,
        manifest: manifest || undefined,
      };
    });
}

/**
 * The image `ref` names for the server's platform. With the containerd image
 * store, an image's ID is its multi-platform index, which is republished
 * whenever any platform is rebuilt, so the platform's manifest is used
 * instead; the classic store only has the platform's image, so its ID is.
 */
async function platformImage(remote: Remote, ref: string): Promise<string | undefined> {
  const result = await remote.exec(
    `docker image inspect --platform ${PLATFORM} --format '{{with .Descriptor}}{{.Digest}}{{else}}{{.Id}}{{end}}' ${q(ref)}`,
    { allowFail: true },
  );
  return result.code === 0 ? result.stdout.trim() : undefined;
}

/** The image a container is running, comparable with platformImage(). */
const runningImage = (c: InfraContainer) => c.manifest ?? c.imageId;

/** Every domain with a Caddy route. */
async function routeDomains(remote: Remote): Promise<string[]> {
  const result = await remote.exec(
    "for f in caddy/sites/*.caddy; do [ -e \"$f\" ] && head -1 \"$f\"; done; true",
  );
  return result.stdout
    .split("\n")
    .flatMap((line) => line.replace(/\s*\{\s*$/, "").split(","))
    .map((address) => address.trim().replace(/^https?:\/\//, ""))
    .filter((domain) => domain && !domain.includes("*"));
}

export type RouteStatuses = Map<string, string>;

/**
 * Request each domain's root through Cloudflare, from here rather than the
 * server, so the tunnel and Caddy are both exercised.
 */
async function checkRoutes(domains: string[]): Promise<RouteStatuses> {
  const entries = await Promise.all(
    domains.map(async (domain): Promise<[string, string]> => {
      try {
        const response = await fetch(`https://${domain}/`, {
          redirect: "manual",
          signal: AbortSignal.timeout(15_000),
        });
        await response.body?.cancel();
        return [domain, String(response.status)];
      } catch (err) {
        return [domain, (err as Error).name === "TimeoutError" ? "timeout" : "error"];
      }
    }),
  );
  return new Map(entries);
}

export function routeDifferences(before: RouteStatuses, after: RouteStatuses): string[] {
  return [...before].flatMap(([domain, status]) =>
    after.get(domain) === status
      ? []
      : [`${domain}: ${status} before, ${after.get(domain) ?? "no response"} now`],
  );
}

/** Poll until every route returns its baseline status, or time out. */
async function waitForRoutes(
  domains: string[],
  baseline: RouteStatuses,
): Promise<string[]> {
  const deadline = Date.now() + ROUTE_SETTLE_SECONDS * 1000;
  let differences: string[] = [];
  while (Date.now() < deadline) {
    differences = routeDifferences(baseline, await checkRoutes(domains));
    if (differences.length === 0) {
      return [];
    }
    await Bun.sleep(3000);
  }
  return differences;
}

/**
 * Point each container's image reference at the image `sources` names for it
 * (a tag, since old images may have no addressable ID), recreate it, and make
 * sure it's running that image.
 */
async function switchImages(
  remote: Remote,
  containers: InfraContainer[],
  sources: Map<string, string>,
) {
  for (const container of containers) {
    const source = sources.get(container.service);
    if (source && source !== container.ref) {
      await remote.exec(`docker tag ${q(source)} ${q(container.ref)}`);
    }
  }
  const services = containers.map((c) => q(c.service)).join(" ");
  // The images are local now; don't let compose pull the tags forward again
  await remote.compose(`up -d --pull never ${services}`, { inherit: true });
  const recreated = await infraContainers(remote);
  for (const { service, ref } of containers) {
    const now = recreated.find((c) => c.service === service);
    const wanted = await platformImage(remote, ref);
    if (!now || !wanted || runningImage(now) !== wanted) {
      throw new DeployError(`${service} isn't running ${ref} after being recreated`);
    }
  }
}

/**
 * Pull newer images for the shared infrastructure (the root compose project)
 * and recreate the containers whose image changed. If a container doesn't
 * come up, or any site's response status changes, the previous images are put
 * back. Services aren't touched: CI redeploys registry-built apps, and locally
 * built ones need `portal deploy`, so this only reports which pinned images
 * have newer versions and which other service images are getting old.
 */
export async function update(remote: Remote) {
  const containers = await infraContainers(remote);
  const domains = await routeDomains(remote);
  const baseline = await spin(`checking ${domains.length} routes`, checkRoutes(domains), {
    persist: true,
  });

  // Hold on to what's running before the pull moves any tags
  const held = new Set<string>();
  for (const { service, ref, imageId: id } of containers) {
    const tagged = await remote.exec(`docker tag ${q(id)} ${q(holdRef(ref))}`, {
      allowFail: true,
    });
    if (tagged.code === 0) {
      held.add(service);
    } else {
      warn(`couldn't keep ${service}'s current image, so it can't be rolled back`);
    }
  }
  const releaseHolds = () =>
    remote.exec(
      `docker image rm ${containers.map((c) => q(holdRef(c.ref))).join(" ")} >/dev/null 2>&1; true`,
    );

  step("pulling infrastructure images");
  try {
    await remote.compose("pull --quiet", { inherit: true });
  } catch (err) {
    await releaseHolds();
    throw err;
  }

  const changed: InfraContainer[] = [];
  for (const container of containers) {
    const pulled = await platformImage(remote, container.ref);
    if (pulled && pulled !== runningImage(container)) {
      changed.push(container);
    }
  }

  // Keep what was running, both for an automatic rollback and for
  // `portal update --rollback` later
  for (const { service, ref } of changed) {
    if (held.has(service)) {
      await remote.exec(`docker tag ${q(holdRef(ref))} ${q(previousRef(ref))}`);
    }
  }
  await releaseHolds();

  if (changed.length === 0) {
    done("infrastructure is up to date");
    await reportStaleServices(remote);
    return;
  }

  step(`updating ${changed.map((c) => c.service).join(", ")}`);
  let failure: string | undefined;
  try {
    await switchImages(remote, changed, new Map());
    for (const { container } of changed) {
      await waitForService(remote, container);
    }
    const differences = await spin("waiting for routes", waitForRoutes(domains, baseline));
    if (differences.length > 0) {
      failure = `routes changed after the update:\n  ${differences.join("\n  ")}`;
    }
  } catch (err) {
    failure = (err as Error).message;
  }

  if (failure) {
    const restorable = changed.filter((c) => held.has(c.service));
    if (restorable.length < changed.length) {
      throw new DeployError(
        `${failure}\nThe previous image of ${changed
          .filter((c) => !held.has(c.service))
          .map((c) => c.service)
          .join(", ")} wasn't kept, so it can't be restored automatically.`,
      );
    }
    warn("update failed; restoring the previous images");
    await switchImages(
      remote,
      changed,
      new Map(changed.map((c) => [c.service, previousRef(c.ref)])),
    );
    for (const { container } of changed) {
      await waitForService(remote, container);
    }
    const stillDifferent = await spin("waiting for routes", waitForRoutes(domains, baseline));
    throw new DeployError(
      `${failure}\n${
        stillDifferent.length === 0
          ? "Restored the previous images; routes are back to their earlier status."
          : `Restored the previous images, but routes still differ:\n  ${stillDifferent.join("\n  ")}`
      }\nPin a version in the root compose.yaml to keep this update from being pulled again.`,
    );
  }

  for (const { service } of changed) {
    done(`updated ${bold(service)}`);
  }
  done(`all ${domains.length} routes respond as before`);

  // Images replaced by earlier updates are untagged now; the ones this update
  // replaced are kept under their -previous tags
  await remote.exec("docker image prune --force >/dev/null", {
    allowFail: true,
  });
  await reportStaleServices(remote);
}

/** The OCI label an image may name its version in, e.g. v2.11.7 */
const VERSION_LABEL = "org.opencontainers.image.version";

/**
 * The digest the running image was pulled as, from its RepoDigests, and its
 * version label, for each infrastructure container.
 */
async function runningImages(
  remote: Remote,
  containers: InfraContainer[],
): Promise<Map<string, { digests: string[]; label?: string }>> {
  const result = await remote.exec(
    `docker image inspect --format '{{.Id}}\t{{join .RepoDigests " "}}\t{{index .Config.Labels "${VERSION_LABEL}"}}' ${containers
      .map((c) => q(c.imageId))
      .join(" ")}`,
    { allowFail: true },
  );
  return new Map(
    result.stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [id = "", digests = "", label = ""] = line.split("\t");
        return [id, { digests: digests.split(" ").filter(Boolean), label: label || undefined }];
      }),
  );
}

/**
 * What `portal update` would move each infrastructure container to, for
 * those it would change: the version its tag points to now, and a newer
 * version of a pinned tag, which only changing the pin gets. Each row is the
 * service, its image, the version it's running and what's available.
 */
async function infraUpdates(remote: Remote): Promise<string[][]> {
  const containers = await infraContainers(remote);
  if (containers.length === 0) {
    return [];
  }
  const running = await runningImages(remote, containers);
  const rows = await Promise.all(
    containers.map(async ({ service, ref, imageId: id, manifest }): Promise<string[][]> => {
      const image = running.get(id);
      const label = image?.label?.replace(/^v(?=\d)/, "");
      // RepoDigests holds one entry per repository the image was pulled from
      const pulled = image?.digests
        .find((d) => d.startsWith(`${imageName(ref)}@`))
        ?.split("@")[1];
      try {
        const [tags, digest] = await Promise.all([listRegistryTags(ref), manifestDigest(ref)]);
        const newer = newestTag(refTag(ref) ?? "latest", tags);
        const latest = await versionOf(ref, digest, tags);
        // The index is republished whenever any platform is rebuilt, so the
        // server's platform decides whether the image is current
        const upToDate =
          pulled === digest ||
          (manifest !== undefined && manifest === (await imageDigest(ref, PLATFORM)));
        const version =
          (upToDate ? latest : pulled && (await versionOf(ref, pulled, tags))) || label;
        const available: string[] = [];
        if (!pulled && !manifest) {
          // Without the digest it was pulled as, only a version change shows
          if (latest && latest !== version) {
            available.push(latest);
          }
        } else if (!upToDate) {
          available.push(
            latest && latest !== version ? latest : `${latest ?? "newer image"} (rebuilt upstream)`,
          );
        }
        if (newer) {
          available.push(`${newer} (change the pin)`);
        }
        return available.length > 0
          ? [[service, ref, version ?? "unknown", available.join(", ")]]
          : [];
      } catch (err) {
        warn(`couldn't check ${ref} for newer versions: ${(err as Error).message}`);
        return [];
      }
    }),
  );
  return rows.flat();
}

/**
 * List every upgrade portal can see without changing anything: newer
 * infrastructure images that `portal update` would pull or that need a pin
 * changed, and newer or rebuilt versions of the images services are pinned
 * to or built from. Then list the services it can't fully check, and why.
 */
export async function outdated(remote: Remote) {
  const [infra, [services, checks]] = await spin(
    `checking for newer images on ${remote.host}`,
    Promise.all([infraUpdates(remote), checkServices(remote)]),
  );
  warnFailedChecks(checks);
  const rows = [
    ...infra,
    ...services.flatMap((s) => upgradeRows(s.name, checks.get(s.name) ?? [])),
  ];
  if (rows.length > 0) {
    printTable(["SERVICE", "IMAGE", "VERSION", "AVAILABLE"], rows);
  } else {
    done("everything is up to date");
  }

  const unchecked = services.flatMap((image) => {
    const reason = uncheckedReason(image, checks.get(image.name) ?? []);
    return reason ? [{ ...image, reason }] : [];
  });
  if (unchecked.length > 0) {
    warn("can't fully check these services:");
    for (const { name, days, reason } of unchecked) {
      const age = Number.isNaN(days) ? "" : `; deployed ${days} days ago`;
      console.error(`  ${name} ${dim(`(${reason}${age})`)}`);
    }
  }
}

/**
 * Switch infrastructure containers back to the images the last update
 * replaced, for problems noticed after it finished.
 */
export async function rollbackUpdate(remote: Remote) {
  const containers = await infraContainers(remote);
  const targets: InfraContainer[] = [];
  const sources = new Map<string, string>();
  for (const container of containers) {
    const previous = await platformImage(remote, previousRef(container.ref));
    if (previous && previous !== runningImage(container)) {
      targets.push(container);
      sources.set(container.service, previousRef(container.ref));
    }
  }
  if (targets.length === 0) {
    done("nothing to roll back: no infrastructure image has a previous version");
    return;
  }

  step(`rolling back ${targets.map((c) => c.service).join(", ")}`);
  await switchImages(remote, targets, sources);
  for (const { container } of targets) {
    await waitForService(remote, container);
  }
  for (const { service } of targets) {
    done(`${bold(service)} is running its previous image`);
  }
  warn(
    "The next `portal update` will pull the newer images again; pin a version in the root compose.yaml to stay on these.",
  );
}

/** Every service's image, and what registries say about the images it uses. */
async function checkServices(remote: Remote) {
  const services = await serviceImages(remote);
  return [services, await checkVersions(services)] as const;
}

/** Warn once for each image a registry couldn't be asked about. */
function warnFailedChecks(checks: Map<string, VersionCheck[]>) {
  const failed = new Map(
    [...checks.values()].flat().flatMap((c) => (c.error ? [[c.ref, c.error]] : [])),
  );
  for (const [ref, error] of failed) {
    warn(`couldn't check ${ref} for newer versions: ${error}`);
  }
}

/**
 * Report services whose pinned image, or the base image their image was built
 * from, has a newer version or has been rebuilt under the same tag, and other
 * services whose image is older than STALE_IMAGE_DAYS.
 */
async function reportStaleServices(remote: Remote) {
  const [services, checks] = await spin("checking service images", checkServices(remote));
  warnFailedChecks(checks);
  const newer = [...checks].flatMap(([name, results]) =>
    results
      .filter((check) => !check.error && isOutdated(check))
      .map((check) => `${name} ${dim(`(${describeCheck(check)})`)}`),
  );
  if (newer.length > 0) {
    warn("outdated images:");
    for (const line of newer) {
      console.error(`  ${line}`);
    }
  }

  // Redeploying a pinned image gets the same image again, and a recorded base
  // digest is checked directly, so age is only a guess for the rest
  const stale = services.filter(
    (s) => !isPinned(s) && !s.baseDigest && s.days >= STALE_IMAGE_DAYS,
  );
  if (stale.length > 0) {
    warn(
      `service images older than ${STALE_IMAGE_DAYS} days (redeploy them to pick up base image updates):`,
    );
    for (const { name, days } of stale) {
      console.error(`  ${name} ${dim(`(${days} days)`)}`);
    }
  }
}
