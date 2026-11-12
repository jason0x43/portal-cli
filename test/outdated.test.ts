import { describe, expect, test } from "bun:test";
import {
  describeCheck,
  serviceImages,
  uncheckedReason,
  upgradeRows,
  versionChecks,
} from "../src/outdated.ts";
import type { Remote } from "../src/remote.ts";

describe("serviceImages", () => {
  const remoteWith = (stdout: string) =>
    ({ exec: async () => ({ stdout, stderr: "", code: 0 }) }) as unknown as Remote;

  test("reads each service's labels and whether it's disabled", async () => {
    const images = await serviceImages(
      remoteWith(
        [
          ["site", "2026-11-01T00:00:00.000000000Z", "", "", "", "joseluisq/static-web-server:2", "sha256:aaa"],
          ["old", "2026-11-01T00:00:00.000000000Z", "", "", "disabled", "node:26-slim", "sha256:bbb"],
          // No image, so its base labels are a single empty field
          ["gone", "", "", "", "disabled", ""],
        ]
          .map((fields) => fields.join("\t"))
          .join("\n"),
      ),
    );
    expect(images.map(({ days: _, ...image }) => image)).toEqual([
      { name: "site", base: "joseluisq/static-web-server:2", baseDigest: "sha256:aaa" },
      { name: "old", base: "node:26-slim", baseDigest: "sha256:bbb", disabled: true },
      { name: "gone", disabled: true },
    ]);
  });
});

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

  test("checks an unversioned base by the digest it was built from", () => {
    expect(
      versionChecks({
        name: "app",
        days: 3,
        base: "debian:trixie-slim",
        baseDigest: "sha256:aaa",
      }),
    ).toEqual([{ kind: "base", ref: "debian:trixie-slim", digest: "sha256:aaa" }]);
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

  test("notes a base whose tag was rebuilt, unless there's a newer version", () => {
    const base = { kind: "base" as const, ref: "debian:trixie-slim", digest: "sha256:aaa" };
    expect(describeCheck({ ...base, rebuilt: true })).toBe(
      "debian trixie-slim (rebuilt upstream)",
    );
    expect(describeCheck({ ...base, rebuilt: false })).toBe("debian trixie-slim");
    expect(
      describeCheck({ kind: "base", ref: "node:26.1.0-slim", newer: "26.12.1-slim", rebuilt: true }),
    ).toBe("node 26.1.0-slim → 26.12.1-slim");
    expect(describeCheck({ kind: "base", ref: "debian" })).toBe("debian latest");
  });
});

describe("upgradeRows", () => {
  test("lists only checks that found something", () => {
    expect(
      upgradeRows("worthy", [
        { kind: "base", ref: "node:26.1.0-slim", newer: "26.12.1-slim" },
        { kind: "base", ref: "debian:trixie-slim", digest: "sha256:aaa", rebuilt: false },
        { kind: "base", ref: "alpine:3.20", error: "401" },
      ]),
    ).toEqual([["worthy", "node:26.1.0-slim (base)", "26.1.0-slim", "26.12.1-slim"]]);
  });

  test("notes a rebuilt base and a pin that needs changing", () => {
    expect(
      upgradeRows("atuin", [
        { kind: "pin", ref: "ghcr.io/atuinsh/atuin:18.23.0", newer: "18.24.0" },
        { kind: "base", ref: "debian:trixie-slim", digest: "sha256:aaa", rebuilt: true },
      ]),
    ).toEqual([
      ["atuin", "ghcr.io/atuinsh/atuin:18.23.0", "18.23.0", "18.24.0 (change the pin)"],
      ["atuin", "debian:trixie-slim (base)", "trixie-slim", "rebuilt upstream"],
    ]);
  });
});

describe("uncheckedReason", () => {
  test("accepts pins and bases with a version or recorded digest", () => {
    const pin = { kind: "pin" as const, ref: "ghcr.io/atuinsh/atuin:18.23.0" };
    expect(uncheckedReason({ name: "atuin", days: 3, source: pin.ref }, [pin])).toBeUndefined();
    expect(
      uncheckedReason({ name: "app", days: 3, base: "debian:trixie-slim", baseDigest: "sha256:aaa" }, [
        { kind: "base", ref: "debian:trixie-slim", digest: "sha256:aaa" },
      ]),
    ).toBeUndefined();
    expect(uncheckedReason({ name: "app", days: 3, base: "node@sha256:aaa" }, [])).toBeUndefined();
    expect(uncheckedReason({ name: "gone", days: NaN }, [])).toBeUndefined();
  });

  test("explains what's missing", () => {
    expect(uncheckedReason({ name: "notes", days: 40 }, [])).toBe(
      "its image has no base image label",
    );
    expect(uncheckedReason({ name: "app", days: 3, source: "ghcr.io/me/app" }, [])).toBe(
      "its image has no base image label",
    );
    expect(uncheckedReason({ name: "app", days: 3, base: "node:lts" }, [])).toBe(
      "node:lts has no version, and no digest is recorded for it",
    );
    const base = { kind: "base" as const, ref: "node:26.1.0-slim" };
    expect(uncheckedReason({ name: "app", days: 3, base: base.ref }, [base])).toBe(
      "no digest recorded for node:26.1.0-slim, so rebuilds of it aren't noticed",
    );
    expect(
      uncheckedReason({ name: "app", days: 3, base: base.ref }, [{ ...base, error: "401" }]),
    ).toBe("couldn't ask the registry");
  });
});
