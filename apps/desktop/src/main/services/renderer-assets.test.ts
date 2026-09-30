// The first `describe` is the containment failure matrix: one row per escape class, each
// asserting the exact serialized result, so a refusal that echoed the attempted path would fail
// here rather than leak. No `electron` mock: the response policy those verdicts turn into is
// asserted in `./renderer-protocol.test.ts`.

import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resolveRendererAsset } from "./renderer-assets.js";

// Planted beside the bundle as a dev tree has them: present on disk and still refused, so a
// pass is the guard working and not a missing file.
const SOURCE_MAP_FIXTURES: readonly string[] = [
  "bundle.js.map",
  "sheet.css.map",
  "UPPER.MAP",
  "assets/app.js.map",
];

let sandboxRoot = "";
let rendererRoot = "";
let outsideRoot = "";

beforeAll(async () => {
  sandboxRoot = await mkdtemp(path.join(tmpdir(), "sidekicks-protocol-test-"));
  rendererRoot = path.join(sandboxRoot, "out", "renderer");
  outsideRoot = path.join(sandboxRoot, "outside");

  await mkdir(path.join(rendererRoot, "assets"), { recursive: true });
  await mkdir(outsideRoot, { recursive: true });

  await writeFile(path.join(outsideRoot, "secret.txt"), "not yours", "utf8");
  for (const fileName of SOURCE_MAP_FIXTURES) {
    await writeFile(path.join(rendererRoot, fileName), '{"sources":["secret.ts"]}', "utf8");
  }
  await writeFile(path.join(rendererRoot, "assets", "app.js"), "x", "utf8");

  // Escape symlink: inside the root, pointing outside it.
  await symlink(path.join(outsideRoot, "secret.txt"), path.join(rendererRoot, "escape.txt"));
  // Negative control: a symlink inside the root to a file inside it must still resolve.
  await symlink(path.join(rendererRoot, "assets", "app.js"), path.join(rendererRoot, "inner.js"));
});

afterAll(async () => {
  if (sandboxRoot !== "") {
    await rm(sandboxRoot, { recursive: true, force: true });
  }
});
describe("resolveRendererAsset containment failure matrix", () => {
  // The exact serialized result is the whole payload: no path, no reason.
  const FORBIDDEN_ROWS: ReadonlyArray<readonly [string, string]> = [
    ["raw dot-dot segment", "sidekicks-renderer://app/../etc/passwd"],
    ["raw dot-dot mid-path", "sidekicks-renderer://app/assets/../../etc/passwd"],
    ["percent-encoded dot-dot", "sidekicks-renderer://app/%2e%2e/etc/passwd"],
    ["percent-encoded separator (upper)", "sidekicks-renderer://app/assets%2F..%2Fescape.txt"],
    ["percent-encoded separator (lower)", "sidekicks-renderer://app/assets%2f..%2fescape.txt"],
    ["percent-encoded backslash (upper)", "sidekicks-renderer://app/assets%5C..%5Cescape.txt"],
    ["percent-encoded backslash (lower)", "sidekicks-renderer://app/assets%5c..%5cescape.txt"],
    ["literal backslash", "sidekicks-renderer://app/assets\\..\\escape.txt"],
    ["absolute path via doubled slash", "sidekicks-renderer://app//etc/passwd"],
    ["absolute path, root only", "sidekicks-renderer://app//"],
    ["windows drive-absolute path", "sidekicks-renderer://app/C:/Windows/win.ini"],
    ["host other than app", "sidekicks-renderer://evil/index.html"],
    ["authority carrying a port", "sidekicks-renderer://app:8080/index.html"],
    ["authority carrying credentials", "sidekicks-renderer://operator@app/index.html"],
    ["different scheme entirely", "https://app/index.html"],
    ["file scheme", "file:///etc/passwd"],
    ["NUL byte in the path", "sidekicks-renderer://app/%00index.html"],
    ["malformed percent escape", "sidekicks-renderer://app/%zz.html"],
    ["not a URL at all", "sidekicks-renderer:/no-authority"],
  ];

  it.each(FORBIDDEN_ROWS)("refuses %s with an empty, path-free result", async (_label, url) => {
    const resolution = await resolveRendererAsset(rendererRoot, url);
    // Exact serialization proves nothing about the attempted path survives.
    expect(JSON.stringify(resolution)).toBe('{"outcome":"forbidden"}');
  });

  it("refuses a symlink that leaves the root", async () => {
    const resolution = await resolveRendererAsset(
      rendererRoot,
      "sidekicks-renderer://app/escape.txt",
    );
    expect(JSON.stringify(resolution)).toBe('{"outcome":"forbidden"}');
  });

  // The escape row's negative control: the guard is about containment, not symlinks.
  it("resolves a symlink that stays inside the root", async () => {
    const resolution = await resolveRendererAsset(
      rendererRoot,
      "sidekicks-renderer://app/inner.js",
    );
    expect(resolution.outcome).toBe("resolved");
  });
});
describe("source maps", () => {
  // Each fixture exists on disk, so a pass is the guard refusing a readable file.
  it.each(SOURCE_MAP_FIXTURES.map((fileName) => [fileName] as const))(
    "answers 'not found' for the planted %s",
    async (fileName) => {
      const resolution = await resolveRendererAsset(
        rendererRoot,
        `sidekicks-renderer://app/${fileName}`,
      );
      // Exact serialization: nothing in the result leaks the path or that the file exists.
      expect(JSON.stringify(resolution)).toBe('{"outcome":"not-found"}');
    },
  );

  it("answers 'not found' for a percent-encoded source-map extension", async () => {
    const resolution = await resolveRendererAsset(
      rendererRoot,
      "sidekicks-renderer://app/bundle.js%2Emap",
    );
    expect(JSON.stringify(resolution)).toBe('{"outcome":"not-found"}');
  });
});
