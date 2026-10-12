#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { deploy } from "./commands/deploy.ts";
import { init } from "./commands/init.ts";
import { update } from "./commands/update.ts";
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

const HELP = `portal: deploy docker services to the portal server

Usage: portal <command> [options]

Commands:
  init                    Create a portal.toml for this project
  ls                      List every service on the server
  update                  Update the shared infrastructure (cloudflared, caddy)
  deploy                  Build, upload, and start the service
  status                  Show the container, image tags, and route
  logs [-f] [-n N]        Show service logs
  restart                 Restart the service
  env [list] [--show]     List server-side environment variables
  env set KEY=VALUE...    Set variables (bare KEY reads the value from stdin)
  env unset KEY...        Remove variables
  rollback [TAG]          Switch back to the previous (or given) image
  remove [--purge]        Stop the service and remove its config

Options:
  -c, --config PATH       Config file (default: ./portal.toml)
  -s, --service NAME      Act on a service without its portal.toml
      --host HOST         ssh host (default: portal)
      --root PATH         Server config dir (default: ~/server)
  -h, --help              Show this help

deploy options:
      --image REF         Deploy a prebuilt image instead of building
      --registry-user U   Registry login user (default: $GITHUB_ACTOR)
      --registry-token T  Registry login token (or $PORTAL_REGISTRY_TOKEN)
      --timeout SECONDS   How long to wait for the container (default: 60)
      --dry-run           Print the generated files without deploying

init options:
      --name, --domain, --port, --static DIR, --image REF, --force
`;

const options = {
  config: { type: "string", short: "c" },
  service: { type: "string", short: "s" },
  host: { type: "string" },
  root: { type: "string" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
  // deploy
  image: { type: "string" },
  "registry-user": { type: "string" },
  "registry-token": { type: "string" },
  timeout: { type: "string" },
  "dry-run": { type: "boolean" },
  // env
  show: { type: "boolean" },
  "no-restart": { type: "boolean" },
  // logs
  follow: { type: "boolean", short: "f" },
  tail: { type: "string", short: "n" },
  // remove
  purge: { type: "boolean" },
  yes: { type: "boolean", short: "y" },
  // init
  name: { type: "string" },
  domain: { type: "string" },
  port: { type: "string" },
  static: { type: "string" },
  force: { type: "boolean" },
} as const;

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

async function main(argv: string[]) {
  const { values: opts, positionals } = parseArgs({
    args: argv,
    options,
    allowPositionals: true,
  });
  const [command, ...args] = positionals;

  if (opts.version) {
    console.log(pkg.version);
    return;
  }
  if (opts.help || !command) {
    console.log(HELP);
    return;
  }

  const target = () => resolveTarget(opts);

  switch (command) {
    case "init":
      return init(opts);

    case "deploy": {
      const config = await loadConfig(opts.config);
      if (opts.host) config.host = opts.host;
      if (opts.root) config.root = opts.root;
      const timeout = opts.timeout ? Number(opts.timeout) : undefined;
      if (timeout !== undefined && !(timeout > 0)) {
        throw new ConfigError("--timeout must be a positive number of seconds");
      }
      return deploy(config, {
        image: opts.image,
        registryUser: opts["registry-user"],
        registryToken: opts["registry-token"] ?? process.env.PORTAL_REGISTRY_TOKEN,
        dryRun: opts["dry-run"],
        timeout,
      });
    }

    case "status":
      return status(await target());

    case "logs":
      return logs(await target(), { follow: opts.follow, tail: opts.tail });

    case "restart":
      return restart(await target());

    case "env": {
      const [sub = "list", ...rest] = args;
      const restartAfter = !opts["no-restart"];
      if (sub === "list") {
        return envList(await target(), { show: opts.show });
      }
      if (sub === "set") {
        return envSet(await target(), rest, { restart: restartAfter });
      }
      if (sub === "unset") {
        return envUnset(await target(), rest, { restart: restartAfter });
      }
      throw new ConfigError(`unknown env command "${sub}" (expected list, set, or unset)`);
    }

    case "rollback":
      return rollback(await target(), args[0]);

    case "remove":
      return remove(await target(), { purge: opts.purge, yes: opts.yes });

    case "ls":
    case "list":
      return list(await serverRemote(opts));

    case "update":
      return update(await serverRemote(opts));

    default:
      throw new ConfigError(`unknown command "${command}" (see portal --help)`);
  }
}

try {
  await main(process.argv.slice(2));
} catch (err) {
  const known =
    err instanceof ConfigError ||
    err instanceof DeployError ||
    err instanceof CommandError ||
    (err as { code?: string }).code?.startsWith("ERR_PARSE_ARGS");
  console.error(red(`error: ${known ? (err as Error).message : String((err as Error).stack ?? err)}`));
  process.exit(1);
}
