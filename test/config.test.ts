import { describe, expect, test } from "bun:test";
import { ConfigError, parseConfig } from "../src/config.ts";

const base = {
  name: "worthy",
  domain: "worthy.jason0x43.dev",
  port: 3000,
  build: true,
};

function parse(overrides: Record<string, unknown>) {
  return parseConfig({ ...base, ...overrides }, "/project");
}

function errorOf(raw: Record<string, unknown>) {
  try {
    parseConfig(raw, "/project");
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigError);
    return (err as Error).message;
  }
  throw new Error("expected a ConfigError");
}

describe("parseConfig", () => {
  test("applies defaults", () => {
    const config = parse({});
    expect(config).toMatchObject({
      name: "worthy",
      domains: ["worthy.jason0x43.dev"],
      port: 3000,
      host: "portal",
      root: "~/server",
      hardened: false,
      source: {
        kind: "build",
        context: ".",
        dockerfile: "Dockerfile",
        args: {},
      },
      env: {},
      compose: {},
      dir: "/project",
    });
  });

  test("accepts a build table, multiple domains, and stringifies env", () => {
    const config = parse({
      domain: ["a.tmpdir.dev", "b.tmpdir.dev"],
      build: { context: "server", target: "prod", args: { VERSION: 2 } },
      env: { PORT: 3000, DEBUG: false, NAME: "x" },
    });
    expect(config.domains).toEqual(["a.tmpdir.dev", "b.tmpdir.dev"]);
    expect(config.source).toEqual({
      kind: "build",
      context: "server",
      dockerfile: "Dockerfile",
      target: "prod",
      args: { VERSION: "2" },
    });
    expect(config.env).toEqual({ PORT: "3000", DEBUG: "false", NAME: "x" });
  });

  test("static sites take no port", () => {
    const config = parseConfig(
      { name: "tmpdir-dev", domain: "tmpdir.dev", static: "dist" },
      "/p",
    );
    expect(config.source).toEqual({ kind: "static", dir: "dist", immutable: [], ignore: [] });
    expect(config.port).toBe(8080);

    const spa = parseConfig(
      {
        name: "app",
        domain: "app.tmpdir.dev",
        static: {
          dir: "build",
          fallback: "index.html",
          immutable: ["assets/**"],
          ignore: ["*.md"],
        },
      },
      "/p",
    );
    expect(spa.source).toEqual({
      kind: "static",
      dir: "build",
      fallback: "index.html",
      immutable: ["assets/**"],
      ignore: ["*.md"],
    });

    expect(
      errorOf({ name: "x", domain: "x.tmpdir.dev", static: { dir: "d", ignore: "*.md" } }),
    ).toContain("static.ignore must be an array");
    expect(errorOf({ ...base, build: undefined, static: "dist" })).toContain(
      "port does not apply",
    );
  });

  test("requires exactly one source", () => {
    expect(errorOf({ ...base, image: "ghcr.io/x/y" })).toContain(
      "exactly one of",
    );
    expect(errorOf({ ...base, build: undefined })).toContain("exactly one of");
  });

  test("reports every problem at once", () => {
    const message = errorOf({ name: "Bad Name", domain: "nope", port: 0 });
    expect(message).toContain("name is required");
    expect(message).toContain('invalid domain "nope"');
    expect(message).toContain("port is required");
    expect(message).toContain("exactly one of");
  });

  test("rejects unknown keys", () => {
    expect(errorOf({ ...base, prot: 3000 })).toContain('unknown key "prot"');
  });

  test("rejects published ports", () => {
    expect(errorOf({ ...base, compose: { ports: ["8080:3000"] } })).toContain(
      "compose.ports is not allowed",
    );
  });

  test("rejects named volumes and paths outside the service dir", () => {
    const message = errorOf({
      ...base,
      compose: { volumes: ["cache:/cache", "../shared:/shared", "/etc:/etc"] },
    });
    expect(message).toContain('"cache:/cache"');
    expect(message).toContain('"../shared:/shared"');
    expect(message).toContain('"/etc:/etc"');
  });

  test("allows bind mounts under the service dir", () => {
    const config = parse({
      compose: {
        volumes: [
          "./uploads:/uploads",
          { type: "bind", source: "./x", target: "/x" },
        ],
      },
    });
    expect(config.compose.volumes).toHaveLength(2);
  });

  test("rejects fields portal manages", () => {
    expect(errorOf({ ...base, compose: { image: "nginx" } })).toContain(
      "compose.image is managed by portal",
    );
  });
});
