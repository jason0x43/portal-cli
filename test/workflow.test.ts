import { describe, expect, test } from "bun:test";
import { parse } from "yaml";
import { ACTION_REQUIRED_INPUTS, actionSteps, updateActionRef } from "../src/workflow.ts";

describe("ACTION_REQUIRED_INPUTS", () => {
  test("matches action.yml", async () => {
    const action = parse(
      await Bun.file(new URL("../action.yml", import.meta.url)).text(),
    ) as { inputs: Record<string, { required?: boolean }> };
    const required = Object.entries(action.inputs)
      .filter(([, input]) => input.required)
      .map(([name]) => name);
    expect(ACTION_REQUIRED_INPUTS.toSorted()).toEqual(required.toSorted());
  });
});

describe("actionSteps", () => {
  test("finds steps using the action, with their job's permissions", () => {
    const workflow = `
permissions:
  contents: read
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
  deploy:
    permissions:
      packages: write
    steps:
      - uses: actions/checkout@v7
      - name: Deploy
        uses: jason0x43/portal-cli@v0.2.0
        with:
          image: ghcr.io/owner/app:sha-abc
  deploy-other:
    steps:
      - uses: Jason0x43/Portal-CLI@main
`;
    expect(actionSteps(workflow)).toEqual([
      {
        job: "deploy",
        ref: "v0.2.0",
        inputs: { image: "ghcr.io/owner/app:sha-abc" },
        readsPackages: true,
      },
      { job: "deploy-other", ref: "main", inputs: {}, readsPackages: false },
    ]);
  });

  test("leaves permissions unknown when the workflow doesn't set them", () => {
    const workflow = "jobs:\n  d:\n    steps:\n      - uses: jason0x43/portal-cli@v0.5.0\n";
    expect(actionSteps(workflow)[0]?.readsPackages).toBeUndefined();
    expect(actionSteps("not: [valid")).toEqual([]);
  });
});

describe("updateActionRef", () => {
  test("moves older releases to the given ref and keeps the formatting", () => {
    const workflow = `jobs:
  deploy:
    steps:
      - uses: actions/checkout@v7
      # Deploy to the server
      - name: Deploy
        uses: jason0x43/portal-cli@v0.5.0 # pinned
        with:
          image: ghcr.io/owner/app:sha-abc
      - uses: "Jason0x43/Portal-CLI@v0.4.1"
`;
    expect(updateActionRef(workflow, "v0.6.0")).toBe(
      workflow
        .replace("portal-cli@v0.5.0", "portal-cli@v0.6.0")
        .replace("Portal-CLI@v0.4.1", "Portal-CLI@v0.6.0"),
    );
  });

  test("leaves branches, commits, and newer releases alone", () => {
    const workflow = `jobs:
  d:
    steps:
      - uses: jason0x43/portal-cli@main
      - uses: jason0x43/portal-cli@3f2a9c1
      - uses: jason0x43/portal-cli@v0.7.0
      - uses: someone/portal-cli@v0.1.0
`;
    expect(updateActionRef(workflow, "v0.6.0")).toBe(workflow);
  });
});
