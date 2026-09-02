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

// This suite keeps a LOCAL `electron` stub rather than the shared
// `test/helpers/electron-mock.ts`, and the reason is mechanical rather than
// stylistic: it imports the module under test STATICALLY, so `electron` is
// resolved during this file's own import phase — before a top-level
// `const electronMock = createElectronMock(...)` would have initialised, which
// would leave the hoisted `vi.mock` factory reading a binding in its temporal
// dead zone. The stub is also the whole surface this file needs, and it
// constructs no window, so it is not a second copy of the shared harness's
// `BrowserWindow` machinery.
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
  buildLoadFailureUrl,
  FALLBACK_CONTENT_TYPE,
  handleRendererRequest,
  LOAD_FAILURE_PATH,
  RENDERER_CONTENT_SECURITY_POLICY,
  RENDERER_SCHEME,
  registerRendererScheme,
  renderLoadFailureDocument,
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
];

// Planted beside the bundle exactly as a dev tree has them: present on disk,
// and still refused. The fixture is what makes the 404 meaningful — a guard
// that only passed because the file was missing would prove nothing.
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
  for (const [fileName] of MAPPED_CONTENT_TYPES) {
    await writeFile(path.join(rendererRoot, fileName), "x", "utf8");
  }
  for (const fileName of SOURCE_MAP_FIXTURES) {
    await writeFile(path.join(rendererRoot, fileName), '{"sources":["secret.ts"]}', "utf8");
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

describe("source maps", () => {
  // Each fixture EXISTS on disk (see the setup above), so a passing row is the
  // guard refusing a readable file and not the filesystem answering for it.
  it.each(SOURCE_MAP_FIXTURES.map((fileName) => [fileName] as const))(
    "answers 'not found' for the planted %s",
    async (fileName) => {
      const resolution = await resolveRendererAsset(
        rendererRoot,
        `sidekicks-renderer://app/${fileName}`,
      );
      // Exact serialization: 404 with nothing else in the result, so the
      // refusal cannot leak the path or the fact that the file is there.
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

  it("answers 'not found' for a source map that is not on disk at all", async () => {
    // The refusal must not be distinguishable from a miss, which is the whole
    // reason it is 404 rather than 403.
    const resolution = await resolveRendererAsset(
      rendererRoot,
      "sidekicks-renderer://app/never-written.js.map",
    );
    expect(JSON.stringify(resolution)).toBe('{"outcome":"not-found"}');
  });

  it("does not refuse a file whose name merely contains 'map'", async () => {
    // Negative control: the guard is a suffix test, not a substring test, so
    // `sitemap.json` and friends still resolve.
    const resolution = await resolveRendererAsset(
      rendererRoot,
      "sidekicks-renderer://app/manifest.json",
    );
    expect(resolution.outcome).toBe("resolved");
  });

  it("serves an empty body for a refused source map over the handler", async () => {
    const response = await handleRendererRequest(
      rendererRoot,
      "sidekicks-renderer://app/bundle.js.map",
    );
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("");
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
  // Asserted on the real Response objects, not on the resolver's verdict: a
  // refusal that carried a body — even an error string — would echo something
  // about the tree, and the CSP header must ride EVERY response including the
  // refusals, because a refusal is still a document a renderer can be pointed at.
  it("refuses an escape with an empty-bodied 403 carrying the locked headers", async () => {
    const response = await handleRendererRequest(
      rendererRoot,
      "sidekicks-renderer://app/../outside/secret.txt",
    );

    expect(response.status).toBe(403);
    expect(await response.text()).toBe("");
    expect(response.headers.get("content-security-policy")).toBe(RENDERER_CONTENT_SECURITY_POLICY);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("answers a miss with an empty-bodied 404 carrying the locked headers", async () => {
    const response = await handleRendererRequest(rendererRoot, "sidekicks-renderer://app/nope.js");

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("");
    expect(response.headers.get("content-security-policy")).toBe(RENDERER_CONTENT_SECURITY_POLICY);
  });

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

// The load-failure document (Codex round 1). A rejected `loadURL` used to leave
// a live blank window; the window now loads this instead. It is generated in the
// main process rather than emitted into the bundle, because the failure it
// reports is "the bundle could not be loaded" — a fallback living in the tree
// that just failed is missing exactly when it is needed.
describe("the load-failure document", () => {
  it("is served for the reserved path, with the reason and the locked headers", async () => {
    const response = await handleRendererRequest(
      rendererRoot,
      buildLoadFailureUrl("ERR_FILE_NOT_FOUND (-6)"),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("content-security-policy")).toBe(RENDERER_CONTENT_SECURITY_POLICY);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");

    const body = await response.text();
    expect(body).toContain("The console could not be loaded");
    expect(body).toContain("ERR_FILE_NOT_FOUND (-6)");
  });

  // The reason is assembled from an error message, one of the few strings in
  // this process a remote input can shape. It must arrive as text even when it
  // is markup — and the document carries no script for it to become part of.
  it("escapes a reason that is markup", async () => {
    const response = await handleRendererRequest(
      rendererRoot,
      buildLoadFailureUrl('</code><script>alert("x")</script>'),
    );

    const body = await response.text();
    expect(body).not.toContain("<script>");
    expect(body).toContain("&lt;script&gt;");
  });

  it("serves the document even with no reason at all", async () => {
    const response = await handleRendererRequest(
      rendererRoot,
      `sidekicks-renderer://app${LOAD_FAILURE_PATH}`,
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("No reason was reported.");
  });

  // Bounded, because an error message is neither bounded nor authored by us and
  // a document that grew with it would be a memory cost driven by the failure.
  it("bounds a very long reason", () => {
    const document = renderLoadFailureDocument("x".repeat(5000));

    expect(document).not.toContain("x".repeat(400));
    expect(document).toContain("x".repeat(300));
  });

  // Exact-path matching, never a prefix: anything else under the reserved path
  // falls through to the ordinary resolver, which refuses it.
  it("does not answer a path that merely starts with the reserved one", async () => {
    const response = await handleRendererRequest(
      rendererRoot,
      `sidekicks-renderer://app${LOAD_FAILURE_PATH}/../index.html`,
    );

    expect(response.status).toBe(403);
    expect(await response.text()).toBe("");
  });

  it("is not served on another host", async () => {
    const response = await handleRendererRequest(
      rendererRoot,
      `sidekicks-renderer://evil${LOAD_FAILURE_PATH}?reason=x`,
    );

    expect(response.status).toBe(403);
  });
});
