// Plan-023 Phase 1B (T-023p-1B-1) — the renderer-scheme handler's failure matrix.
//
// The first `describe` below IS the containment failure matrix: one row per
// escape class, each asserting the EXACT serialized result, so a refusal that
// started echoing the attempted path would fail here rather than leak. The
// matrix was written before the handler and is the reason `resolveRendererAsset`
// reads the raw URL text instead of the parsed `pathname` — the WHATWG parser
// silently collapses `..`, which would have made row 1 unreachable.
//
// `electron` is mocked: the package's real entry point exports a binary-path
// string outside an Electron process, so a bare import would fail to resolve the
// named `net` / `protocol` bindings at all.

import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const electronMock = vi.hoisted(() => ({
  registerSchemesAsPrivileged: vi.fn(),
  handle: vi.fn(),
  netFetch: vi.fn(),
}));

vi.mock("electron", () => ({
  protocol: {
    registerSchemesAsPrivileged: electronMock.registerSchemesAsPrivileged,
    handle: electronMock.handle,
  },
  net: { fetch: electronMock.netFetch },
}));

import {
  FALLBACK_CONTENT_TYPE,
  RENDERER_CONTENT_SECURITY_POLICY,
  RENDERER_SCHEME,
  registerRendererScheme,
  resolveRendererAsset,
} from "./protocol.js";

// Extensions the closed content-type map covers, paired with the exact type the
// handler must serve. A row removed from the map without a row removed here
// fails; a row added to the map without a row here is caught by the
// closed-set assertion at the end of that block.
const MAPPED_CONTENT_TYPES: ReadonlyArray<readonly [string, string]> = [
  ["index.html", "text/html; charset=utf-8"],
  ["bundle.js", "text/javascript; charset=utf-8"],
  ["module.mjs", "text/javascript; charset=utf-8"],
  ["sheet.css", "text/css; charset=utf-8"],
  ["manifest.json", "application/json; charset=utf-8"],
  ["glyph.svg", "image/svg+xml"],
  ["shot.png", "image/png"],
  ["shot.webp", "image/webp"],
  ["plex.woff2", "font/woff2"],
  ["parser.wasm", "application/wasm"],
  ["bundle.js.map", "application/json; charset=utf-8"],
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
  for (const [fileName] of MAPPED_CONTENT_TYPES) {
    await writeFile(path.join(rendererRoot, fileName), "x", "utf8");
  }
  await writeFile(path.join(rendererRoot, "LICENSE"), "x", "utf8");
  await writeFile(path.join(rendererRoot, "notes.txt"), "x", "utf8");
  await writeFile(path.join(rendererRoot, "assets", "app.js"), "x", "utf8");

  // Escape symlink: lives INSIDE the root, points OUTSIDE it.
  await symlink(path.join(outsideRoot, "secret.txt"), path.join(rendererRoot, "escape.txt"));
  // Negative control: a symlink INSIDE the root pointing at a file INSIDE the
  // root must still resolve. Without this, a guard that simply refused every
  // symlink would pass the escape row and prove nothing.
  await symlink(path.join(rendererRoot, "assets", "app.js"), path.join(rendererRoot, "inner.js"));
});

afterAll(async () => {
  if (sandboxRoot !== "") {
    await rm(sandboxRoot, { recursive: true, force: true });
  }
});

describe("resolveRendererAsset containment failure matrix", () => {
  // Every row asserts the EXACT serialized result. `{"outcome":"forbidden"}` is
  // the whole payload — no path, no reason, no filesystem shape.
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
    // Exact serialization: proves both the verdict AND that nothing about the
    // attempted path survives into the caller's hands.
    expect(JSON.stringify(resolution)).toBe('{"outcome":"forbidden"}');
  });

  it("refuses a symlink that leaves the root", async () => {
    const resolution = await resolveRendererAsset(
      rendererRoot,
      "sidekicks-renderer://app/escape.txt",
    );
    expect(JSON.stringify(resolution)).toBe('{"outcome":"forbidden"}');
  });

  // The escape row's negative control. A guard that refused every symlink would
  // pass the row above while being wrong; this proves the guard is about
  // CONTAINMENT, not about symlinks.
  it("resolves a symlink that stays inside the root", async () => {
    const resolution = await resolveRendererAsset(
      rendererRoot,
      "sidekicks-renderer://app/inner.js",
    );
    expect(resolution.outcome).toBe("resolved");
  });
});

describe("resolveRendererAsset misses", () => {
  const NOT_FOUND_ROWS: ReadonlyArray<readonly [string, string]> = [
    ["a path that does not exist", "sidekicks-renderer://app/nope.js"],
    ["a directory", "sidekicks-renderer://app/assets"],
    ["the bare root, since there is no index.html fallback", "sidekicks-renderer://app/"],
    ["a URL with no path component", "sidekicks-renderer://app"],
    ["a URL that is only a query", "sidekicks-renderer://app?route=timeline"],
  ];

  it.each(NOT_FOUND_ROWS)("answers 'not found' for %s", async (_label, url) => {
    const resolution = await resolveRendererAsset(rendererRoot, url);
    expect(JSON.stringify(resolution)).toBe('{"outcome":"not-found"}');
  });
});

describe("resolveRendererAsset content types", () => {
  it.each(MAPPED_CONTENT_TYPES)("serves %s as %s", async (fileName, expectedContentType) => {
    const resolution = await resolveRendererAsset(
      rendererRoot,
      `sidekicks-renderer://app/${fileName}`,
    );
    expect(resolution).toStrictEqual({
      outcome: "resolved",
      absolutePath: expect.stringContaining(fileName) as unknown as string,
      contentType: expectedContentType,
    });
  });

  it.each([["LICENSE"], ["notes.txt"]])(
    "serves the unmapped %s as application/octet-stream",
    async (fileName) => {
      const resolution = await resolveRendererAsset(
        rendererRoot,
        `sidekicks-renderer://app/${fileName}`,
      );
      expect(resolution.outcome).toBe("resolved");
      expect(resolution.outcome === "resolved" && resolution.contentType).toBe(
        FALLBACK_CONTENT_TYPE,
      );
    },
  );

  it("resolves a nested asset and returns a path inside the root", async () => {
    const resolution = await resolveRendererAsset(
      rendererRoot,
      "sidekicks-renderer://app/assets/app.js?v=abc#/window/timeline",
    );
    expect(resolution.outcome).toBe("resolved");
    if (resolution.outcome !== "resolved") return;
    // Query and fragment are not part of the path, and the returned path sits
    // under the root's realpath (`/var` is a symlink to `/private/var` on macOS,
    // so the comparison is against the resolved root, not the raw one).
    expect(path.basename(resolution.absolutePath)).toBe("app.js");
    expect(resolution.absolutePath.endsWith(path.join("assets", "app.js"))).toBe(true);
  });
});

describe("the locked response policy", () => {
  it("carries every Spec-023 §Security Hardening Baseline directive", () => {
    for (const directive of [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "connect-src 'self'",
      "img-src 'self' data: blob:",
      "font-src 'self'",
      "frame-src 'none'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
    ]) {
      expect(RENDERER_CONTENT_SECURITY_POLICY).toContain(directive);
    }
    // No `unsafe-eval` and no inline script anywhere: `Spec-023 §Renderer Bundle`
    // names both as the reason the bundle is served over a custom scheme at all.
    expect(RENDERER_CONTENT_SECURITY_POLICY).not.toContain("unsafe-eval");
    expect(RENDERER_CONTENT_SECURITY_POLICY).not.toContain("script-src 'self' 'unsafe-inline'");
  });
});

// Registration is process-global state, so this block runs last and owns both
// calls. Splitting it across files would leave the second call's verdict
// dependent on file ordering.
describe("registerRendererScheme", () => {
  it("registers the scheme as standard and secure, then refuses a second call", () => {
    registerRendererScheme();

    expect(electronMock.registerSchemesAsPrivileged).toHaveBeenCalledTimes(1);
    expect(electronMock.registerSchemesAsPrivileged).toHaveBeenCalledWith([
      {
        scheme: RENDERER_SCHEME,
        // `standard: true` is what gives the origin IndexedDB and localStorage
        // (Plan-023 I-023-11); `secure: true` is what keeps the document out of
        // Chromium's mixed-content and insecure-origin restrictions.
        privileges: { standard: true, secure: true, supportFetchAPI: true },
      },
    ]);

    expect(() => {
      registerRendererScheme();
    }).toThrow(/called twice/i);
    // The refused second call must not reach Electron.
    expect(electronMock.registerSchemesAsPrivileged).toHaveBeenCalledTimes(1);
  });
});
