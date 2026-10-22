import { describe, expect, test } from "bun:test";
import { describeCheck, outdatedSummary, versionChecks } from "../src/outdated.ts";

describe("versionChecks", () => {
  test("checks a versioned pin and a versioned base", () => {
    expect(
      versionChecks({
        name: "atuin",
        days: 3,
        source: "ghcr.io/atuinsh/atuin:18.23.0",
        base: "debian:12.8-slim",
      }),
    ).toEqual([
      { kind: "pin", ref: "ghcr.io/atuinsh/atuin:18.23.0" },
      { kind: "base", ref: "debian:12.8-slim" },
    ]);
  });

  test("skips images that aren't pinned to a version", () => {
    expect(
      versionChecks({ name: "app", days: 3, source: "ghcr.io/me/app:latest", base: "node:lts" }),
    ).toEqual([]);
  });
});

describe("describeCheck", () => {
  test("names the base image and shows the newer version", () => {
    expect(describeCheck({ kind: "base", ref: "node:26.1.0-slim", newer: "26.12.1-slim" })).toBe(
      "node 26.1.0-slim → 26.12.1-slim",
    );
    expect(describeCheck({ kind: "pin", ref: "ghcr.io/atuinsh/atuin:18.23.0" })).toBe(
      "pinned 18.23.0",
    );
  });
});

describe("outdatedSummary", () => {
  const built = { name: "worthy", days: 3, base: "node:26.1.0-slim" };

  test("shows the base image, with a newer version if there is one", () => {
    expect(outdatedSummary(built, [{ kind: "base", ref: built.base }])).toBe(
      "node 26.1.0-slim",
    );
    expect(
      outdatedSummary(built, [{ kind: "base", ref: built.base, newer: "26.12.1-slim" }]),
    ).toBe("node 26.1.0-slim → 26.12.1-slim");
    expect(outdatedSummary(built, [{ kind: "base", ref: built.base, error: "401" }])).toBe(
      "node 26.1.0-slim (couldn't check)",
    );
  });

  test("shows a pinned image's base only when it's outdated", () => {
    const pinned = { name: "atuin", days: 3, source: "ghcr.io/atuinsh/atuin:18.23.0" };
    const pin = { kind: "pin" as const, ref: pinned.source };
    const base = { kind: "base" as const, ref: "debian:12.8-slim" };
    expect(outdatedSummary(pinned, [pin, base])).toBe("pinned 18.23.0");
    expect(outdatedSummary(pinned, [pin, { ...base, newer: "12.9-slim" }])).toBe(
      "pinned 18.23.0, debian 12.8-slim → 12.9-slim",
    );
  });

  test("flags images without a base image label", () => {
    expect(outdatedSummary({ name: "notes", days: 40 }, [])).toBe("unlabeled");
    expect(outdatedSummary({ name: "app", days: 3, source: "ghcr.io/me/app:latest" }, [])).toBe(
      "unlabeled",
    );
    expect(outdatedSummary({ name: "app", days: 3, base: "node:lts" }, [])).toBe(
      "node:lts (not a version)",
    );
  });

  test("shows nothing for a service with no image", () => {
    expect(outdatedSummary({ name: "gone", days: NaN }, [])).toBe("-");
  });
});
