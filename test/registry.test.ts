import { describe, expect, test } from "bun:test";
import {
  imageName,
  newestTag,
  repositoryOf,
  versionCandidates,
} from "../src/registry.ts";

describe("newestTag", () => {
  const tags = [
    "latest",
    "18.2.0",
    "v18.2.0",
    "18.23.0",
    "18.24.2",
    "v18.24.2",
    "18.25.0-beta.1",
    "18.24",
    "18.10.0",
  ];

  test("finds the highest version newer than the pin, compared numerically", () => {
    expect(newestTag("18.2.0", tags)).toBe("18.24.2");
  });

  test("keeps the pin's prefix, suffix and number of parts", () => {
    expect(newestTag("v18.2.0", tags)).toBe("v18.24.2");
    expect(newestTag("18.23", tags)).toBe("18.24");
    expect(newestTag("1.27-alpine", ["1.27-alpine", "1.28", "1.29-alpine"])).toBe(
      "1.29-alpine",
    );
  });

  test("is undefined when the pin is current or not a version", () => {
    expect(newestTag("18.24.2", tags)).toBeUndefined();
    expect(newestTag("latest", tags)).toBeUndefined();
  });
});

describe("versionCandidates", () => {
  const tags = [
    "latest",
    "2",
    "2.10",
    "2.10.3",
    "2.11",
    "2.11.6",
    "2.11.7",
    "2.11.7-alpine",
    "2.12.0-beta.1",
    "2.11.7.1",
  ];

  test("lists versions within a moving version tag, most specific and newest first", () => {
    expect(versionCandidates("2.11", tags)).toEqual(["2.11.7.1", "2.11.7", "2.11.6"]);
    expect(versionCandidates("2.11-alpine", tags)).toEqual(["2.11.7-alpine"]);
  });

  test("lists every unsuffixed version for an unversioned tag", () => {
    expect(versionCandidates("latest", tags)).toEqual([
      "2.11.7.1",
      "2.11.7",
      "2.11.6",
      "2.10.3",
      "2.11",
      "2.10",
      "2",
    ]);
  });

  test("is empty for a fully specific tag", () => {
    expect(versionCandidates("2.11.7.1", tags)).toEqual([]);
  });
});

describe("imageName", () => {
  test("drops the tag and digest", () => {
    expect(imageName("node:26.10.0-slim")).toBe("node");
    expect(imageName("localhost:5000/app:1.0@sha256:abc")).toBe("localhost:5000/app");
    expect(imageName("localhost:5000/app")).toBe("localhost:5000/app");
  });
});

describe("repositoryOf", () => {
  test("splits registry and repository", () => {
    expect(repositoryOf("ghcr.io/atuinsh/atuin:18.23.0")).toEqual({
      host: "ghcr.io",
      repository: "atuinsh/atuin",
    });
    expect(repositoryOf("localhost:5000/app:1.0@sha256:abc")).toEqual({
      host: "localhost:5000",
      repository: "app",
    });
  });

  test("uses Docker Hub's registry and library namespace", () => {
    expect(repositoryOf("caddy:2.11")).toEqual({
      host: "registry-1.docker.io",
      repository: "library/caddy",
    });
    expect(repositoryOf("cloudflare/cloudflared:latest")).toEqual({
      host: "registry-1.docker.io",
      repository: "cloudflare/cloudflared",
    });
  });
});
