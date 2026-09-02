// Plan-023 Phase 1B (T-023p-1B-1) — the Electron seam: scheme registration and
// the response policy the handler answers with.
//
// Scoped to what needs `electron`. The verdicts this policy is built on are
// asserted without a mock in `./renderer-assets.test.ts`, and the failure
// document's own text in `./load-failure-document.test.ts`; what is left here is
// the part that cannot be tested without the module that imports `electron`:
// the statuses, the empty refusal bodies, and the locked headers riding EVERY
// response — refusals included, because a refusal is still a document a renderer
// can be pointed at.
//
// `electron` is mocked: the package's real entry point exports a binary-path
// string outside an Electron process, so a bare import would fail to resolve the
// named `net` / `protocol` bindings at all.

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

import { buildLoadFailureUrl, LOAD_FAILURE_PATH } from "./load-failure-document.js";
import { handleRendererRequest, registerRendererScheme } from "./protocol.js";
import { RENDERER_CONTENT_SECURITY_POLICY, RENDERER_SCHEME } from "./renderer-scheme.js";

let sandboxRoot = "";
let rendererRoot = "";

beforeAll(async () => {
  sandboxRoot = await mkdtemp(path.join(tmpdir(), "sidekicks-protocol-test-"));
  rendererRoot = path.join(sandboxRoot, "out", "renderer");

  await mkdir(rendererRoot, { recursive: true });
  // Planted on disk exactly as a dev tree has it, so the 404 below is the guard
  // refusing a readable file and not the filesystem answering for it.
  await writeFile(path.join(rendererRoot, "bundle.js.map"), '{"sources":["secret.ts"]}', "utf8");
});

afterAll(async () => {
  if (sandboxRoot !== "") {
    await rm(sandboxRoot, { recursive: true, force: true });
  }
});

describe("the locked response policy", () => {
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

  it("serves an empty body for a refused source map that IS on disk", async () => {
    const response = await handleRendererRequest(
      rendererRoot,
      "sidekicks-renderer://app/bundle.js.map",
    );

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("");
  });
});

describe("the load-failure document over the handler", () => {
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

  // Answered without touching the filesystem — the whole reason this document
  // is servable when the tree is not. `rendererRoot` here is a path that does
  // not exist at all, and the response is still a 200.
  it("is served even when the renderer root is gone", async () => {
    const response = await handleRendererRequest(
      path.join(sandboxRoot, "no-such-tree"),
      buildLoadFailureUrl("ERR_FILE_NOT_FOUND (-6)"),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("ERR_FILE_NOT_FOUND (-6)");
  });

  it("falls through to the resolver for a path that merely starts with it", async () => {
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
