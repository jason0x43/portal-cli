import { describe, expect, test } from "bun:test";
import { previousRef, routeDifferences } from "../src/commands/update.ts";

describe("previousRef", () => {
  test("adds -previous to the tag", () => {
    expect(previousRef("caddy:2.11")).toBe("caddy:2.11-previous");
    expect(previousRef("cloudflare/cloudflared:latest")).toBe(
      "cloudflare/cloudflared:latest-previous",
    );
  });

  test("treats an untagged ref as latest", () => {
    expect(previousRef("nginx")).toBe("nginx:latest-previous");
    expect(previousRef("localhost:5000/app")).toBe("localhost:5000/app:latest-previous");
  });
});

describe("routeDifferences", () => {
  const baseline = new Map([
    ["tmpdir.dev", "200"],
    ["worthy.jason0x43.dev", "302"],
  ]);

  test("is empty when every route matches", () => {
    expect(routeDifferences(baseline, new Map(baseline))).toEqual([]);
  });

  test("lists routes whose status changed or that stopped responding", () => {
    expect(
      routeDifferences(
        baseline,
        new Map([
          ["tmpdir.dev", "502"],
          ["worthy.jason0x43.dev", "302"],
        ]),
      ),
    ).toEqual(["tmpdir.dev: 200 before, 502 now"]);
    expect(routeDifferences(baseline, new Map([["tmpdir.dev", "200"]]))).toEqual([
      "worthy.jason0x43.dev: 302 before, no response now",
    ]);
  });
});
