// The response policy: statuses, empty refusal bodies, and the locked
// headers on every response, refusals included. Verdicts are tested in
// `./renderer-assets.test.ts`. `electron` is mocked because its real entry point exports a
// binary-path string outside an Electron process.

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// A local stub rather than the shared `tests/helpers/electron-mock.ts`: the module under test
// is imported statically, so `electron` resolves before a top-level `createElectronMock(...)`
// would initialize, leaving the hoisted `vi.mock` factory in its temporal dead zone.
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

import { buildLoadFailureUrl, LOAD_FAILURE_PATH } from "../windows/load-failure-document.js";
import { handleRendererRequest } from "./renderer-protocol.js";
import { RENDERER_CONTENT_SECURITY_POLICY } from "./renderer-scheme.js";

let sandboxRoot = "";
let rendererRoot = "";

beforeAll(async () => {
  sandboxRoot = await mkdtemp(path.join(tmpdir(), "sidekicks-protocol-test-"));
  rendererRoot = path.join(sandboxRoot, "out", "renderer");

  await mkdir(rendererRoot, { recursive: true });
  // Planted on disk as a dev tree has it, so the 404 below is the guard refusing a readable file.
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

  // Answered without touching the file system, so it is servable when the tree is not.
  it("is served even when the renderer root is gone", async () => {
    const response = await handleRendererRequest(
      path.join(sandboxRoot, "no-such-tree"),
      buildLoadFailureUrl("ERR_FILE_NOT_FOUND (-6)"),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("ERR_FILE_NOT_FOUND (-6)");
  });

  it("is not served on another host", async () => {
    const response = await handleRendererRequest(
      rendererRoot,
      `sidekicks-renderer://evil${LOAD_FAILURE_PATH}?reason=x`,
    );

    expect(response.status).toBe(403);
  });
});
