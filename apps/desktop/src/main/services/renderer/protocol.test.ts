// The response policy: statuses, empty refusal bodies, and the locked headers on every response,
// refusals included; a tree or asset main could not read is written to main's log. Verdicts are
// tested in `./assets.test.ts`. `electron` is mocked because its real entry point exports a
// binary-path string outside an Electron process.

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// A local stub rather than the shared `tests/helpers/electron/mock/module.ts`: the module
// under test is imported statically, so `electron` resolves before a top-level
// `createElectronMock(...)` would initialize, leaving the hoisted `vi.mock` factory in its temporal
// dead zone.
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

import { buildLoadFailureUrl, LOAD_FAILURE_PATH } from "../../windows/load-failure/document.js";
import type { MainDiagnosticEntry } from "../diagnostic-log.js";
import { handleRendererRequest } from "./protocol.js";
import { RENDERER_CONTENT_SECURITY_POLICY } from "./scheme.js";

/** The kept appearance record, on the dark scheme. */
const RECORD_KEPT = {
  record: {
    theme: "meridian" as const,
    scheme: "dark" as const,
    textSize: 18 as const,
    transcriptWidth: 40,
    grounds: { light: "#ffffff", dark: "#101010" },
  },
  platformScheme: "light" as const,
  isSafeStart: false,
};

/** The built console document's opening, as `src/renderer/index.html` has it. */
const CONSOLE_DOCUMENT = '<!doctype html>\n<html lang="en">\n  <head></head>\n</html>\n';

let sandboxRoot = "";
let rendererRoot = "";

/** Main's log as the handler writes it, emptied before each case. */
const logged: MainDiagnosticEntry[] = [];
const LOG = {
  write: (entry: MainDiagnosticEntry): void => {
    logged.push(entry);
  },
};

beforeEach(() => {
  logged.length = 0;
});

beforeAll(async () => {
  sandboxRoot = await mkdtemp(path.join(tmpdir(), "sidekicks-protocol-test-"));
  rendererRoot = path.join(sandboxRoot, "out", "renderer");

  await mkdir(rendererRoot, { recursive: true });
  // Planted on disk as a dev tree has it, so the 404 below is the guard refusing a readable file.
  await writeFile(path.join(rendererRoot, "bundle.js.map"), '{"sources":["secret.ts"]}', "utf8");
  await writeFile(path.join(rendererRoot, "index.html"), CONSOLE_DOCUMENT, "utf8");
  await writeFile(path.join(rendererRoot, "about.html"), CONSOLE_DOCUMENT, "utf8");
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
      RECORD_KEPT,
      LOG,
    );

    expect(response.status).toBe(403);
    expect(await response.text()).toBe("");
    expect(response.headers.get("content-security-policy")).toBe(RENDERER_CONTENT_SECURITY_POLICY);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("answers a miss with an empty-bodied 404 carrying the locked headers", async () => {
    const response = await handleRendererRequest(
      rendererRoot,
      "sidekicks-renderer://app/nope.js",
      RECORD_KEPT,
      LOG,
    );

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("");
    expect(response.headers.get("content-security-policy")).toBe(RENDERER_CONTENT_SECURITY_POLICY);
  });

  it("serves an empty body for a refused source map that IS on disk", async () => {
    const response = await handleRendererRequest(
      rendererRoot,
      "sidekicks-renderer://app/bundle.js.map",
      RECORD_KEPT,
      LOG,
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
      RECORD_KEPT,
      LOG,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("content-security-policy")).toBe(RENDERER_CONTENT_SECURITY_POLICY);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");

    const body = await response.text();
    expect(body).toContain("<h1>The app's window could not load.</h1>");
    expect(body).toContain("ERR_FILE_NOT_FOUND (-6)");
  });

  // Answered without touching the file system, so it is servable when the tree is not.
  it("is served even when the renderer root is gone", async () => {
    const response = await handleRendererRequest(
      path.join(sandboxRoot, "no-such-tree"),
      buildLoadFailureUrl("ERR_FILE_NOT_FOUND (-6)"),
      RECORD_KEPT,
      LOG,
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("ERR_FILE_NOT_FOUND (-6)");
  });

  it("falls through to the resolver for a path that merely starts with it", async () => {
    const response = await handleRendererRequest(
      rendererRoot,
      `sidekicks-renderer://app${LOAD_FAILURE_PATH}/../index.html`,
      RECORD_KEPT,
      LOG,
    );

    expect(response.status).toBe(403);
    expect(await response.text()).toBe("");
  });

  it("is not served on another host", async () => {
    const response = await handleRendererRequest(
      rendererRoot,
      `sidekicks-renderer://evil${LOAD_FAILURE_PATH}?reason=x`,
      RECORD_KEPT,
      LOG,
    );

    expect(response.status).toBe(403);
  });
});

describe("the root stamp", () => {
  it("is written on the console document's root", async () => {
    electronMock.netFetch.mockResolvedValueOnce(new Response(CONSOLE_DOCUMENT));

    const response = await handleRendererRequest(
      rendererRoot,
      "sidekicks-renderer://app/index.html#/sessions",
      RECORD_KEPT,
      LOG,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toBe(RENDERER_CONTENT_SECURITY_POLICY);
    expect(await response.text()).toContain(
      '<html lang="en" data-theme="meridian" data-color-scheme="dark" ' +
        'data-resolved-color-scheme="dark" style="font-size:18px;--meridian-transcript-width:40rem">',
    );
  });

  it("stamps the scheme the platform draws in when the record follows the system", async () => {
    electronMock.netFetch.mockResolvedValueOnce(new Response(CONSOLE_DOCUMENT));

    const response = await handleRendererRequest(
      rendererRoot,
      "sidekicks-renderer://app/index.html",
      {
        ...RECORD_KEPT,
        record: { ...RECORD_KEPT.record, scheme: "system" },
        platformScheme: "dark",
      },
      LOG,
    );

    expect(await response.text()).toContain(
      '<html lang="en" data-theme="meridian" data-resolved-color-scheme="dark" ' +
        'style="font-size:18px;--meridian-transcript-width:40rem">',
    );
  });

  it("marks a safe start on the console document's root, and only then", async () => {
    electronMock.netFetch.mockResolvedValueOnce(new Response(CONSOLE_DOCUMENT));

    const response = await handleRendererRequest(
      rendererRoot,
      "sidekicks-renderer://app/index.html",
      { ...RECORD_KEPT, isSafeStart: true },
      LOG,
    );

    expect(await response.text()).toContain(
      '<html lang="en" data-theme="meridian" data-color-scheme="dark" ' +
        'data-resolved-color-scheme="dark" data-safe-start ' +
        'style="font-size:18px;--meridian-transcript-width:40rem">',
    );
  });

  it("is written on the console document however its path is spelled", async () => {
    electronMock.netFetch.mockResolvedValueOnce(new Response(CONSOLE_DOCUMENT));

    const response = await handleRendererRequest(
      rendererRoot,
      "sidekicks-renderer://app/%69ndex.html",
      RECORD_KEPT,
      LOG,
    );

    expect(await response.text()).toContain('data-theme="meridian"');
  });

  it("leaves every other document as built", async () => {
    electronMock.netFetch.mockResolvedValueOnce(new Response(CONSOLE_DOCUMENT));

    const response = await handleRendererRequest(
      rendererRoot,
      "sidekicks-renderer://app/about.html",
      RECORD_KEPT,
      LOG,
    );

    expect(await response.text()).toBe(CONSOLE_DOCUMENT);
  });
});

describe("a read main could not make", () => {
  it("answers a tree main cannot read with an empty 403 and writes why to main's log", async () => {
    const response = await handleRendererRequest(
      path.join(sandboxRoot, "no-such-tree"),
      "sidekicks-renderer://app/index.html",
      RECORD_KEPT,
      LOG,
    );

    expect(response.status).toBe(403);
    expect(await response.text()).toBe("");
    expect(logged).toMatchObject([
      { level: "error", message: expect.stringContaining("the renderer tree could not be read") },
    ]);
  });

  it("answers a failed asset read with an empty 404 and writes it to main's log", async () => {
    electronMock.netFetch.mockRejectedValueOnce(new Error("EIO: i/o error"));

    const response = await handleRendererRequest(
      rendererRoot,
      "sidekicks-renderer://app/about.html",
      RECORD_KEPT,
      LOG,
    );

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("");
    expect(logged).toMatchObject([{ level: "error", message: expect.stringContaining("EIO") }]);
  });

  it("negative control: a refused escape writes nothing", async () => {
    await handleRendererRequest(
      rendererRoot,
      "sidekicks-renderer://app/../outside/secret.txt",
      RECORD_KEPT,
      LOG,
    );

    expect(logged).toStrictEqual([]);
  });
});
