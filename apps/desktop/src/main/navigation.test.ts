// Plan-023 Phase 1B (T-023p-1B-2) — the navigation classifier.
//
// `window.test.ts` asserts that the policy is INSTALLED on every window and that
// each verdict is acted on. This file asserts the classification itself, where
// the traps live:
//
//   • `URL.origin` is the string `"null"` for every non-special scheme, and
//     `sidekicks-renderer:` is non-special in Node's WHATWG parser. A classifier
//     comparing `.origin` would find `"null" === "null"` and admit `weird://app`,
//     `nonsense://anything`, and every other non-special scheme as in-window.
//   • `shell.openExternal` hands a string to the OS handler registry, so the
//     allowlist is what keeps a "link" from being a local-execution primitive.
//
// Both are false-PASS directions: a wrong answer here does not break anything
// visible, it quietly widens what a hardened window may become.

import { beforeEach, describe, expect, it, vi } from "vitest";

// This suite keeps a LOCAL `electron` stub rather than the shared
// `test/helpers/electron-mock.ts`, and the reason is mechanical rather than
// stylistic: it imports the module under test STATICALLY, so `electron` is
// resolved during this file's own import phase — before a top-level
// `const electronMock = createElectronMock(...)` would have initialised, which
// would leave the hoisted `vi.mock` factory reading a binding in its temporal
// dead zone. The stub is also the whole surface this file needs, and it
// constructs no window, so it is not a second copy of the shared harness's
// `BrowserWindow` machinery.
const shellMock = vi.hoisted(() => {
  const openedUrls: string[] = [];
  return {
    openedUrls,
    reset(): void {
      openedUrls.length = 0;
    },
  };
});

vi.mock("electron", () => ({
  shell: {
    openExternal: vi.fn((url: string) => {
      shellMock.openedUrls.push(url);
      return Promise.resolve();
    }),
  },
}));

import {
  classifyNavigation,
  EXTERNAL_URL_SCHEME_ALLOWLIST,
  openExternalUrl,
  type InWindowOrigin,
} from "./navigation.js";

const RENDERER_ORIGINS: readonly InWindowOrigin[] = [
  { protocol: "sidekicks-renderer:", host: "app" },
];

describe("classifyNavigation", () => {
  it("admits the renderer scheme's own origin", () => {
    expect(classifyNavigation("sidekicks-renderer://app/index.html", RENDERER_ORIGINS)).toEqual({
      kind: "in-window",
    });
  });

  it("admits a hash route on that origin", () => {
    expect(
      classifyNavigation(
        "sidekicks-renderer://app/index.html#/window/timeline/0f1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d",
        RENDERER_ORIGINS,
      ),
    ).toEqual({ kind: "in-window" });
  });

  // The `.origin` trap: both of these parse to `origin === "null"`, and a
  // classifier comparing origins would call the second one in-window.
  it("refuses a different non-special scheme even though both origins are null", () => {
    expect(new URL("sidekicks-renderer://app/x").origin).toBe("null");
    expect(new URL("sidekicks-imposter://app/x").origin).toBe("null");

    expect(classifyNavigation("sidekicks-imposter://app/x", RENDERER_ORIGINS)).toEqual({
      kind: "refused",
      reason: "navigation target is outside every allowed scheme",
    });
  });

  it("refuses another host on the renderer scheme", () => {
    expect(classifyNavigation("sidekicks-renderer://evil/x", RENDERER_ORIGINS)).toMatchObject({
      kind: "refused",
    });
  });

  it("classifies allowlisted external schemes as external", () => {
    for (const protocol of EXTERNAL_URL_SCHEME_ALLOWLIST) {
      expect(classifyNavigation(`${protocol}//example.test/docs`, RENDERER_ORIGINS)).toEqual({
        kind: "external",
      });
    }
  });

  it.each([
    ["file:///etc/passwd"],
    ["javascript:alert(1)"],
    ["data:text/html,<script>alert(1)</script>"],
    ["ms-msdt:/id PCWDiagnostic"],
    ["blob:https://example.test/abc"],
  ])("refuses %s", (targetUrl) => {
    expect(classifyNavigation(targetUrl, RENDERER_ORIGINS)).toMatchObject({ kind: "refused" });
  });

  it("refuses a target carrying credentials", () => {
    expect(classifyNavigation("https://app@evil.test/looks-like-app", RENDERER_ORIGINS)).toEqual({
      kind: "refused",
      reason: "navigation target carries credentials",
    });
  });

  it("refuses an unparseable target", () => {
    expect(classifyNavigation("not a url at all", RENDERER_ORIGINS)).toEqual({
      kind: "refused",
      reason: "unparseable navigation target",
    });
  });

  it("compares scheme and host case-insensitively", () => {
    expect(classifyNavigation("SIDEKICKS-RENDERER://APP/index.html", RENDERER_ORIGINS)).toEqual({
      kind: "in-window",
    });
  });

  it("refuses everything when no in-window origin is supplied", () => {
    expect(classifyNavigation("sidekicks-renderer://app/index.html", [])).toMatchObject({
      kind: "refused",
    });
  });
});

describe("openExternalUrl", () => {
  beforeEach(() => {
    shellMock.reset();
  });

  it("opens an allowlisted target", async () => {
    openExternalUrl("https://example.test/docs");

    await vi.waitFor(() => {
      expect(shellMock.openedUrls).toEqual(["https://example.test/docs"]);
    });
  });

  // The re-check is the point: this function is the single place a URL reaches
  // `shell.openExternal`, and a guard that only holds when the caller remembered
  // to classify first is not a guard.
  it("opens nothing for a target outside the allowlist, even when called directly", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    openExternalUrl("file:///etc/passwd");

    await new Promise((resolve) => setImmediate(resolve));
    expect(shellMock.openedUrls).toEqual([]);
    expect(consoleError).toHaveBeenCalledTimes(1);
  });
});
