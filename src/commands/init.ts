import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";
import { CONFIG_FILE, parseConfig } from "../config.ts";
import { DeployError } from "../server.ts";
import { done } from "../ui.ts";

export interface InitOptions {
  name?: string;
  domain?: string;
  port?: string;
  static?: string;
  image?: string;
  force?: boolean;
}

/** Write a starter portal.toml, prompting for anything not given as a flag. */
export async function init(options: InitOptions) {
  if (existsSync(CONFIG_FILE) && !options.force) {
    throw new DeployError(`${CONFIG_FILE} already exists (pass --force to overwrite)`);
  }

  const ask = (question: string, fallback: string) =>
    process.stdin.isTTY ? prompt(question, fallback)?.trim() || fallback : fallback;

  const defaultName = basename(resolve("."))
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const name = options.name ?? ask("Service name:", defaultName);

  let source: string;
  if (options.static) {
    source = `static = ${JSON.stringify(options.static)}`;
  } else if (options.image) {
    source = `image = ${JSON.stringify(options.image)}`;
  } else if (existsSync("Dockerfile")) {
    source = "build = true";
  } else {
    const dir = ask("No Dockerfile found. Static directory to serve (blank to build anyway):", "");
    source = dir ? `static = ${JSON.stringify(dir)}` : "build = true";
  }
  const isStatic = source.startsWith("static");

  const domain = options.domain ?? ask("Domain:", `${name}.tmpdir.dev`);
  const port = isStatic ? undefined : (options.port ?? ask("Container port:", "3000"));

  const lines = [
    `name = ${JSON.stringify(name)}`,
    `domain = ${JSON.stringify(domain)}`,
    ...(port ? [`port = ${port}`] : []),
    "",
    source,
  ];
  if (!isStatic) {
    lines.push(
      "",
      "# Non-secret environment, written into the generated compose file.",
      "# Secrets live only on the server: portal env set KEY=value",
      "[env]",
      '# NODE_ENV = "production"',
      "",
      "# The service's data directory is mounted at /data and backed up.",
      "# Anything else here is merged into the generated compose service.",
      "# [compose]",
      '# healthcheck = { test = ["CMD", "wget", "-qO-", "http://localhost:3000/health"] }',
    );
  }
  const text = `${lines.join("\n")}\n`;

  // Make sure what we write is valid before writing it
  parseConfig(Bun.TOML.parse(text), resolve("."));
  await Bun.write(CONFIG_FILE, text);
  done(`wrote ${CONFIG_FILE}`);
}
