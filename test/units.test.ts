import { describe, expect, test } from "bun:test";
import { formatValue, parseEnv, setVars, unsetVars } from "../src/dotenv.ts";
import { DEPLOY_TAG_RE, deployedAt, deployTag, refTag, registryOf, stageStaticSite } from "../src/image.ts";
import { q, qPath, Remote } from "../src/remote.ts";

describe("dotenv", () => {
  const text = "# secrets\nAPI_KEY=abc\nexport TOKEN='x y'\nURL=http://a # note\n";

  test("parses values, quotes, and inline comments", () => {
    expect(Object.fromEntries(parseEnv(text))).toEqual({
      API_KEY: "abc",
      TOKEN: "x y",
      URL: "http://a",
    });
  });

  test("updates in place and appends new keys", () => {
    expect(setVars(text, { API_KEY: "new", EXTRA: "1" })).toBe(
      "# secrets\nAPI_KEY=new\nexport TOKEN='x y'\nURL=http://a # note\nEXTRA=1\n",
    );
    expect(setVars("", { A: "1" })).toBe("A=1\n");
  });

  test("quotes values compose would otherwise interpolate or truncate", () => {
    expect(formatValue("plain-value_1.2")).toBe("plain-value_1.2");
    expect(formatValue("has space")).toBe("'has space'");
    expect(formatValue("pa$$word")).toBe("'pa$$word'");
    expect(formatValue("a #b")).toBe("'a #b'");
    expect(() => formatValue("it's")).toThrow();
  });

  test("round-trips quoted values", () => {
    const out = setVars("", { SECRET: "a b$c#d" });
    expect(parseEnv(out).get("SECRET")).toBe("a b$c#d");
  });

  test("unsets keys and keeps everything else", () => {
    expect(unsetVars(text, ["API_KEY", "TOKEN"])).toBe(
      "# secrets\nURL=http://a # note\n",
    );
  });
});

describe("image refs", () => {
  test("registryOf", () => {
    expect(registryOf("ghcr.io/jason0x43/worthy:latest")).toBe("ghcr.io");
    expect(registryOf("localhost:5000/app")).toBe("localhost:5000");
    expect(registryOf("nginx")).toBe("docker.io");
    expect(registryOf("library/nginx:1")).toBe("docker.io");
  });

  test("refTag", () => {
    expect(refTag("ghcr.io/a/b:sha-123")).toBe("sha-123");
    expect(refTag("localhost:5000/app")).toBeUndefined();
    expect(refTag("nginx@sha256:abc")).toBeUndefined();
  });
});

describe("shell quoting", () => {
  test("q", () => {
    expect(q("services/app/compose.yaml")).toBe("services/app/compose.yaml");
    expect(q("it's here")).toBe(`'it'\\''s here'`);
    expect(q("$(rm -rf /)")).toBe("'$(rm -rf /)'");
  });

  test("qPath keeps ~ expandable", () => {
    expect(qPath("~/server")).toBe("~/server");
    expect(qPath("~/my server")).toBe("~/'my server'");
    expect(qPath("/srv/x")).toBe("/srv/x");
  });
});

describe("deploy tags", () => {
  test("sort in deploy order", () => {
    const a = deployTag("abc123", new Date("2026-10-11T20:34:12.345Z"));
    const b = deployTag(undefined, new Date("2026-10-11T21:00:00Z"));
    expect(a).toBe("20261011-203412-abc123");
    expect(b).toBe("20261011-210000");
    expect([a, b].sort().reverse()).toEqual([b, a]);
    expect(DEPLOY_TAG_RE.test(a) && DEPLOY_TAG_RE.test(b)).toBe(true);
    expect(DEPLOY_TAG_RE.test("latest")).toBe(false);
    expect(DEPLOY_TAG_RE.test("build-20261011-203412")).toBe(false);
  });

  test("reads the time back out of a deploy tag", () => {
    const at = new Date("2026-10-11T20:34:12Z");
    expect(deployedAt(deployTag("abc123", at))).toEqual(at);
    expect(deployedAt(deployTag(undefined, at))).toEqual(at);
    expect(deployedAt("latest")).toBeUndefined();
  });
});

describe("stageStaticSite", () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require("node:fs");
  const { join } = require("node:path");
  const { tmpdir } = require("node:os");

  const files = [
    "index.html",
    "portal.toml",
    ".env",
    ".git/config",
    ".well-known/security.txt",
    "README.md",
    "drafts/post.html",
    "sub/page.html",
    "sub/.DS_Store",
    "sub/portal.toml",
    "sub/notes.md",
    "vendor/.git",
    "vendor/lib.js",
  ];

  function staged(ignore: string[] = []) {
    const project = mkdtempSync(join(tmpdir(), "portal-test-"));
    for (const f of files) {
      mkdirSync(join(project, f, ".."), { recursive: true });
      writeFileSync(join(project, f), f);
    }
    const staging = stageStaticSite(project, project, ignore);
    const out = [...new Bun.Glob("**").scanSync({ cwd: join(staging, "site"), dot: true })].sort();
    rmSync(project, { recursive: true });
    rmSync(staging, { recursive: true });
    return out;
  }

  test("by default leaves out only .git and the project's portal.toml", () => {
    expect(staged()).toEqual([
      ".env",
      ".well-known/security.txt",
      "README.md",
      "drafts/post.html",
      "index.html",
      "sub/.DS_Store",
      "sub/notes.md",
      "sub/page.html",
      "sub/portal.toml",
      "vendor/lib.js",
    ]);
  });

  test("applies ignore patterns like .gitignore", () => {
    expect(staged(["*.md", ".DS_Store", "/.env", "drafts/", "sub/portal.toml"])).toEqual([
      ".well-known/security.txt",
      "index.html",
      "sub/page.html",
      "vendor/lib.js",
    ]);
  });

  test("anchored patterns don't match deeper paths", () => {
    expect(staged(["/sub/*.md", "/README.md"])).not.toContain("README.md");
    expect(staged(["/notes.md"])).toContain("sub/notes.md");
  });
});

describe("Remote", () => {
  test("runs over ssh in the root directory, under sh", () => {
    const argv = new Remote("portal", "~/server").sshArgv("docker compose ps");
    expect(argv[0]).toBe("ssh");
    expect(argv.at(-2)).toBe("portal");
    expect(argv.at(-1)).toBe("sh -c 'cd ~/server && docker compose ps'");
  });

  test("runs directly for the local host", () => {
    const remote = new Remote("local", "~/server");
    expect(remote.isLocal).toBe(true);
    expect(remote.sshArgv("docker compose ps")).toEqual([
      "sh",
      "-c",
      "cd ~/server && docker compose ps",
    ]);
  });

  test("execs tty commands so Ctrl-C ends them cleanly", () => {
    const argv = new Remote("portal", "~/server").sshArgv("docker compose logs -f", true);
    expect(argv).toContain("-t");
    expect(argv).toContain("LogLevel=ERROR");
    expect(argv.at(-1)).toBe("sh -c 'cd ~/server && exec docker compose logs -f'");
  });
});
