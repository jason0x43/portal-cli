import { q, type Remote } from "../remote.ts";
import { waitForService } from "../server.ts";
import { bold, dim, done, step, warn } from "../ui.ts";

/** Service images older than this get a reminder to redeploy them. */
export const STALE_IMAGE_DAYS = 30;

interface InfraContainer {
  service: string;
  container: string;
  imageId: string;
}

/** Containers in the root (infrastructure) project and the images they run. */
async function infraContainers(remote: Remote): Promise<InfraContainer[]> {
  const result = await remote.compose(
    `ps --format '{{.Service}}\t{{.Name}}'`,
  );
  const containers: InfraContainer[] = [];
  for (const line of result.stdout.trim().split("\n").filter(Boolean)) {
    const [service = "", container = ""] = line.split("\t");
    const image = await remote.exec(
      `docker inspect --format '{{.Image}}' ${q(container)}`,
    );
    containers.push({ service, container, imageId: image.stdout.trim() });
  }
  return containers;
}

/**
 * Pull newer images for the shared infrastructure (the root compose project)
 * and recreate the containers whose image changed. Services aren't touched:
 * CI redeploys registry-built apps, and locally built ones need `portal
 * deploy`, so this only reports which service images are getting old.
 */
export async function update(remote: Remote) {
  const before = await infraContainers(remote);

  step("pulling infrastructure images");
  await remote.compose("pull --quiet", { inherit: true });
  // Only containers whose image or config changed are recreated
  await remote.compose("up -d", { inherit: true });

  const after = await infraContainers(remote);
  const changed = after.filter(
    (c) => before.find((b) => b.service === c.service)?.imageId !== c.imageId,
  );
  for (const { service, container } of changed) {
    await waitForService(remote, container);
    done(`updated ${bold(service)}`);
  }
  if (changed.length === 0) {
    done("infrastructure is up to date");
  }

  // Old images replaced by this or earlier updates no longer have a tag
  await remote.exec("docker image prune --force >/dev/null", {
    allowFail: true,
  });

  await reportStaleServices(remote);
}

/** List services whose deployed image is older than STALE_IMAGE_DAYS. */
async function reportStaleServices(remote: Remote) {
  const result = await remote.exec(
    [
      "for f in services/*/compose.yaml; do",
      '  [ -e "$f" ] || continue',
      '  n=${f#services/}; n=${n%/compose.yaml}',
      `  printf '%s\\t%s\\n' "$n" "$(docker image inspect --format '{{.Created}}' "portal/$n:latest" 2>/dev/null)"`,
      "done; true",
    ].join("\n"),
  );
  const now = Date.now();
  const stale = result.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [name = "", created = ""] = line.split("\t");
      // Docker reports nanoseconds; Date.parse only needs milliseconds
      const createdAt = Date.parse(created.replace(/(\.\d{3})\d*/, "$1"));
      const days = Math.floor((now - createdAt) / 86_400_000);
      return { name, days };
    })
    .filter(({ days }) => days >= STALE_IMAGE_DAYS);

  if (stale.length > 0) {
    warn(
      `service images older than ${STALE_IMAGE_DAYS} days (redeploy them to pick up base image updates):`,
    );
    for (const { name, days } of stale) {
      console.error(`  ${name} ${dim(`(${days} days)`)}`);
    }
  }
}
