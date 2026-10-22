#!/usr/bin/env bun
import { Command, InvalidArgumentError, Option } from "@commander-js/extra-typings";
import { deploy } from "./commands/deploy.ts";
import { doctor } from "./commands/doctor.ts";
import { init } from "./commands/init.ts";
import { labels } from "./commands/labels.ts";
import { rollbackUpdate, update } from "./commands/update.ts";
import {
  envList,
  envSet,
  envUnset,
  list,
  logs,
  remove,
  restart,
  rollback,
  status,
} from "./commands/manage.ts";
import { existsSync } from "node:fs";
import {
  CONFIG_FILE,
  ConfigError,
  DEFAULT_HOST,
  DEFAULT_ROOT,
  loadConfig,
} from "./config.ts";
import { CommandError, Remote } from "./remote.ts";
import { DeployError, resolveTarget } from "./server.ts";
import { red } from "./ui.ts";
import pkg from "../package.json";

/**
 * The server for commands that aren't about one service. Uses portal.toml's
 * host and root if there is one, but doesn't need it.
 */
async function serverRemote(opts: {
  config?: string;
  host?: string;
  root?: string;
}): Promise<Remote> {
  const config = existsSync(opts.config ?? CONFIG_FILE)
    ? await loadConfig(opts.config)
    : undefined;
  return new Remote(
    opts.host ?? config?.host ?? DEFAULT_HOST,
    opts.root ?? config?.root ?? DEFAULT_ROOT,
  );
}

function positiveSeconds(value: string): number {
  const seconds = Number(value);
  if (!(seconds > 0)) {
    throw new InvalidArgumentError("must be a positive number of seconds");
  }
  return seconds;
}

const program = new Command()
  .name("portal")
  .description("Deploy docker services to the portal server")
  .version(pkg.version, "-v, --version")
  .option("-c, --config <path>", "config file (default: ./portal.toml)")
  .option("-s, --service <name>", "act on a service without its portal.toml")
  .option(
    "--host <host>",
    `ssh host (default: portal), or "local" to run on this machine (e.g. from a timer on the server)`,
  )
  .option("--root <path>", "server config dir (default: ~/server)")
  .configureOutput({ outputError: (str, write) => write(red(str)) });

program
  .command("init")
  .description("Create a portal.toml for this project")
  .option("--name <name>", "service name")
  .option("--domain <domain>", "domain to route to the service")
  .option("--port <port>", "port the container listens on")
  .option("--static <dir>", "serve a directory of static files")
  .option("--image <ref>", "run a prebuilt image")
  .option("--force", "overwrite an existing portal.toml")
  .action((opts) => init(opts));

program
  .command("ls")
  .alias("list")
  .description("List every service on the server")
  .option("--outdated", "check pinned and base images for newer versions")
  .action(async (opts, cmd) => list(await serverRemote(cmd.optsWithGlobals()), opts));

program
  .command("update")
  .description("Update the shared infrastructure (cloudflared, caddy)")
  .option("--rollback", "switch back to the images the last update replaced")
  .action(async (opts, cmd) => {
    const remote = await serverRemote(cmd.optsWithGlobals());
    return opts.rollback ? rollbackUpdate(remote) : update(remote);
  });

program
  .command("deploy")
  .description("Build, upload, and start the service")
  .option("--image <ref>", "deploy a prebuilt image instead of building")
  .option("--registry-user <user>", "registry login user (default: $GITHUB_ACTOR)")
  .addOption(
    new Option("--registry-token <token>", "registry login token").env(
      "PORTAL_REGISTRY_TOKEN",
    ),
  )
  .option(
    "--timeout <seconds>",
    "how long to wait for the container (default: 60)",
    positiveSeconds,
  )
  .option("--dry-run", "print the generated files without deploying")
  .action(async (opts, cmd) => {
    const globals = cmd.optsWithGlobals();
    const config = await loadConfig(globals.config);
    const { host, root } = globals;
    if (host) config.host = host;
    if (root) config.root = root;
    return deploy(config, opts);
  });

program
  .command("status")
  .description("Show the container, image tags, and route")
  .action(async (_opts, cmd) => status(await resolveTarget(cmd.optsWithGlobals())));

program
  .command("logs")
  .description("Show service logs")
  .option("-f, --follow", "follow log output")
  .option("-n, --tail <lines>", "number of lines to show (default: 100)")
  .action(async (opts, cmd) => logs(await resolveTarget(cmd.optsWithGlobals()), opts));

program
  .command("restart")
  .description("Restart the service")
  .action(async (_opts, cmd) => restart(await resolveTarget(cmd.optsWithGlobals())));

const env = program
  .command("env")
  .description("Manage the service's server-side environment variables");

env
  .command("list", { isDefault: true })
  .description("List the variables")
  .option("--show", "show values, not just names")
  .action(async (opts, cmd) => envList(await resolveTarget(cmd.optsWithGlobals()), opts));

env
  .command("set")
  .description("Set variables (a bare KEY reads the value from stdin)")
  .usage("[options] KEY=VALUE... (or KEY with the value on stdin)")
  .argument("<assignments...>", "KEY=VALUE or KEY")
  .option("--no-restart", "don't restart the service")
  .action(async (assignments, opts, cmd) =>
    envSet(await resolveTarget(cmd.optsWithGlobals()), assignments, opts),
  );

env
  .command("unset")
  .description("Remove variables")
  .usage("[options] KEY...")
  .argument("<keys...>")
  .option("--no-restart", "don't restart the service")
  .action(async (keys, opts, cmd) =>
    envUnset(await resolveTarget(cmd.optsWithGlobals()), keys, opts),
  );

program
  .command("rollback")
  .description("Switch back to the previous (or given) image")
  .argument("[tag]")
  .action(async (tag, _opts, cmd) => rollback(await resolveTarget(cmd.optsWithGlobals()), tag));

program
  .command("remove")
  .description("Stop the service and remove its config")
  .option("--purge", "also remove its data and .env")
  .option("-y, --yes", "don't ask for confirmation")
  .action(async (opts, cmd) => remove(await resolveTarget(cmd.optsWithGlobals()), opts));

program
  .command("labels")
  .description("Print the labels portal adds to images it builds, for a build done elsewhere such as in CI")
  .action(async (_opts, cmd) => labels(await loadConfig(cmd.optsWithGlobals().config)));

program
  .command("doctor")
  .description("Check the config, Dockerfile, server, and service")
  .option("--fix", "label the Dockerfile's base image and update the CI action")
  .action((_opts, cmd) => doctor(cmd.optsWithGlobals()));

try {
  if (process.argv.length <= 2) {
    program.help();
  }
  await program.parseAsync();
} catch (err) {
  const known =
    err instanceof ConfigError ||
    err instanceof DeployError ||
    err instanceof CommandError;
  console.error(red(`error: ${known ? (err as Error).message : String((err as Error).stack ?? err)}`));
  process.exit(1);
}
