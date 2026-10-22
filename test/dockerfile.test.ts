import { describe, expect, test } from "bun:test";
import {
  addBaseLabel,
  analyzeBase,
  DockerfileError,
  labelMatches,
  parseInstructions,
} from "../src/dockerfile.ts";

const worthy = `FROM node:26.10.0-slim AS base
WORKDIR /app

FROM base AS install
RUN npm install --global pnpm@12.6.0

FROM install AS build
RUN pnpm build

FROM base AS deploy
LABEL org.opencontainers.image.source=https://github.com/jason0x43/worthy
LABEL org.opencontainers.image.licenses="UNLICENSED"

ENV NODE_ENV=production
CMD ["node", "scripts/server.ts"]
`;

describe("parseInstructions", () => {
  test("joins continuation lines and skips comments and heredocs", () => {
    const text = [
      "# syntax=docker/dockerfile:1",
      "FROM alpine",
      "RUN apk add \\",
      "  # a comment",
      "  curl",
      "COPY <<EOF /etc/app.conf",
      "FROM not-a-stage",
      "EOF",
      "CMD true",
    ].join("\n");
    expect(parseInstructions(text).map((i) => [i.keyword, i.args, i.start, i.end])).toEqual([
      ["FROM", "alpine", 1, 1],
      ["RUN", "apk add  curl", 2, 4],
      ["COPY", "<<EOF /etc/app.conf", 5, 7],
      ["CMD", "true", 8, 8],
    ]);
  });
});

describe("analyzeBase", () => {
  test("follows stages back to the image the output is built from", () => {
    const { stage, base, label } = analyzeBase(worthy);
    expect(stage.name).toBe("deploy");
    expect(base?.value).toBe("node:26.10.0-slim");
    expect(label).toBeUndefined();
  });

  test("uses the build target and build args", () => {
    const text = "ARG NODE=26\nFROM node:${NODE}-slim AS app\nFROM busybox AS other\n";
    const { stage, base } = analyzeBase(text, { target: "app", args: { NODE: "27" } });
    expect(stage.name).toBe("app");
    expect(base?.value).toBe("node:27-slim");
    expect(() => analyzeBase(text, { target: "nope" })).toThrow(DockerfileError);
  });

  test("notices a label whose ARG isn't declared in its stage", () => {
    const text = [
      "ARG BASE_IMAGE=node:26-slim",
      "FROM ${BASE_IMAGE}",
      "LABEL org.opencontainers.image.base.name=${BASE_IMAGE}",
    ].join("\n");
    const analysis = analyzeBase(text);
    expect(analysis.label?.missing).toEqual(["BASE_IMAGE"]);
    expect(labelMatches(analysis)).toBe(false);
  });

  test("has no base for scratch builds", () => {
    expect(analyzeBase("FROM golang:1.25 AS build\nFROM scratch\n").base).toBeUndefined();
  });
});

describe("addBaseLabel", () => {
  test("moves an inline base image into an ARG and labels the output stage", () => {
    expect(addBaseLabel(worthy)).toBe(`ARG BASE_IMAGE=node:26.10.0-slim
FROM \${BASE_IMAGE} AS base
WORKDIR /app

FROM base AS install
RUN npm install --global pnpm@12.6.0

FROM install AS build
RUN pnpm build

FROM base AS deploy
LABEL org.opencontainers.image.source=https://github.com/jason0x43/worthy
LABEL org.opencontainers.image.licenses="UNLICENSED"
ARG BASE_IMAGE
LABEL org.opencontainers.image.base.name=\${BASE_IMAGE}

ENV NODE_ENV=production
CMD ["node", "scripts/server.ts"]
`);
  });

  test("leaves a correct label alone", () => {
    const fixed = addBaseLabel(worthy);
    expect(addBaseLabel(fixed)).toBe(fixed);
  });

  test("handles a single stage", () => {
    expect(addBaseLabel("FROM --platform=linux/amd64 nginx:1.27-alpine\nCOPY . /srv\n")).toBe(
      [
        "ARG BASE_IMAGE=nginx:1.27-alpine",
        "FROM --platform=linux/amd64 ${BASE_IMAGE}",
        "ARG BASE_IMAGE",
        "LABEL org.opencontainers.image.base.name=${BASE_IMAGE}",
        "COPY . /srv",
        "",
      ].join("\n"),
    );
  });

  test("reuses ARGs the base image already uses", () => {
    expect(addBaseLabel("ARG NODE=26\nFROM node:${NODE}-slim\nCMD node\n")).toBe(
      [
        "ARG NODE=26",
        "FROM node:${NODE}-slim",
        "ARG NODE",
        "LABEL org.opencontainers.image.base.name=node:${NODE}-slim",
        "CMD node",
        "",
      ].join("\n"),
    );
  });

  test("replaces a wrong label", () => {
    const text = [
      "ARG BASE_IMAGE=node:26-slim",
      "FROM ${BASE_IMAGE}",
      "LABEL org.opencontainers.image.base.name=${BASE_IMAGE}",
      "CMD node",
    ].join("\n");
    expect(addBaseLabel(text)).toBe(
      [
        "ARG BASE_IMAGE=node:26-slim",
        "FROM ${BASE_IMAGE}",
        "ARG BASE_IMAGE",
        "LABEL org.opencontainers.image.base.name=${BASE_IMAGE}",
        "CMD node",
      ].join("\n"),
    );
  });

  test("refuses scratch builds", () => {
    expect(() => addBaseLabel("FROM scratch\n")).toThrow(DockerfileError);
  });
});
