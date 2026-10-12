import {
  imageRepo,
  renderService,
  renderSite,
  renderStaticDockerfile,
  servicePath,
} from "../compose.ts";
import type { Config } from "../config.ts";
import * as image from "../image.ts";
import { q, Remote } from "../remote.ts";
import {
  DeployError,
  serviceCompose,
  sitePath,
  updateSite,
  waitForService,
} from "../server.ts";
import { bold, dim, done, step, warn } from "../ui.ts";

export interface DeployOptions {
  /** Deploy this prebuilt image instead of the configured source */
  image?: string;
  registryUser?: string;
  registryToken?: string;
  dryRun?: boolean;
  /** Seconds to wait for the container to come up */
  timeout?: number;
}

export async function deploy(config: Config, options: DeployOptions = {}) {
  const remote = new Remote(config.host, config.root);
  if (options.image && config.source.kind === "static") {
    throw new DeployError("--image can't be used with a static site");
  }

  if (options.dryRun) {
    return dryRun(config);
  }

  await deployContainer(config, remote, options);

  done(
    `deployed ${bold(config.name)} to ${config.domains.map((d) => `https://${d}`).join(", ")}`,
  );
}

async function deployContainer(
  config: Config,
  remote: Remote,
  options: DeployOptions,
) {
  const { name } = config;
  const repo = imageRepo(name);
  let tag: string;

  // What's running now, so a failed deploy can put it back
  const previousImage = (
    await remote.exec(
      `docker image inspect --format '{{.Id}}' ${q(`${repo}:latest`)} 2>/dev/null || true`,
    )
  ).stdout.trim();

  if (options.image || config.source.kind === "image") {
    const ref =
      options.image ?? (config.source.kind === "image" ? config.source.image : "");
    step(`pulling ${ref} on ${remote.host}`);
    const login = options.registryToken
      ? {
          user: options.registryUser ?? process.env.GITHUB_ACTOR ?? "portal",
          token: options.registryToken,
        }
      : undefined;
    tag = await image.pull(remote, ref, login);
    await image.retag(remote, name, ref, tag);
    // The image is kept under portal/<name>; drop the registry tag so they don't pile up
    await remote.exec(`docker image rm ${q(ref)}`, { allowFail: true });
  } else {
    tag = image.deployTag(await image.sourceRevision(config.dir));
    step(`building ${repo}:${tag} for ${image.PLATFORM}`);
    await image.build(config, tag);
    step(`sending image to ${remote.host}`);
    await image.transfer(remote, `${repo}:${tag}`, step);
    await image.retag(remote, name, `${repo}:${tag}`, tag);
  }

  step("writing service config");
  const composePath = servicePath(name);
  const compose = renderService(config);
  const previousCompose = await remote.readFile(composePath);
  if (previousCompose !== compose) {
    await remote.writeFile(composePath, compose);
  }
  if (config.source.kind !== "static") {
    await remote.exec(`mkdir -p ${q(`services/${name}/data`)}`);
  }

  step(`starting ${name}`);
  try {
    await serviceCompose(remote, name, "up -d --force-recreate", { inherit: true });
    await waitForService(remote, name, { timeout: options.timeout });
  } catch (err) {
    if (previousImage && previousCompose !== undefined) {
      await restorePrevious(remote, name, previousImage, previousCompose);
    }
    throw err;
  }
  done(`${name} is running ${dim(`(${repo}:${tag})`)}`);

  if (await updateSite(remote, name, renderSite(config))) {
    done("updated Caddy route");
  }

  const pruned = await image.prune(remote, name).catch((err: unknown) => {
    warn(`couldn't prune old images: ${(err as Error).message}`);
    return [];
  });
  if (pruned.length > 0) {
    step(`removed old images: ${pruned.join(", ")}`);
  }
}

/** Put back the image and compose file that were running before a failed deploy. */
async function restorePrevious(
  remote: Remote,
  name: string,
  imageId: string,
  compose: string,
) {
  warn("deploy failed; restoring the previous version");
  try {
    await remote.exec(`docker tag ${q(imageId)} ${q(`${imageRepo(name)}:latest`)}`);
    await remote.writeFile(servicePath(name), compose);
    await serviceCompose(remote, name, "up -d --force-recreate", { inherit: true });
    await waitForService(remote, name);
    done(`${name} is running the previous version`);
  } catch (err) {
    warn(`couldn't restore the previous version: ${(err as Error).message}`);
  }
}

function dryRun(config: Config) {
  const show = (path: string, content: string) =>
    console.log(`${bold(`# ${path}`)}\n${content}`);
  if (config.source.kind === "static") {
    show("Dockerfile (generated)", renderStaticDockerfile(config));
  }
  show(`${config.root}/${servicePath(config.name)}`, renderService(config));
  show(`${config.root}/${sitePath(config.name)}`, renderSite(config));
}
