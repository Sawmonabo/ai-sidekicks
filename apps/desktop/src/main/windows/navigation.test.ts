// The navigation classifier. `window-navigation.test.ts` asserts the policy is installed and each verdict
// acted on; this asserts the classification itself. Two traps: `URL.origin` is `"null"` for every
// non-special scheme (and `sidekicks-renderer:` is non-special in Node's parser), so comparing
// `.origin` would admit `weird://app` and the like; and `shell.openExternal` hands a string to the
// OS handler registry, so the allowlist keeps a "link" from being a local-execution primitive.
// Both are false-pass directions: a wrong answer breaks nothing visible.

import { beforeEach, describe, expect, it, vi } from "vitest";

// A local `electron` stub rather than the shared `tests/helpers/electron-mock.ts`: the module
// under test is imported statically, so `electron` resolves before a top-level
// `createElectronMock(...)` would initialize, leaving the hoisted `vi.mock` factory in its
// temporal dead zone.
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

import { WEB_ADDRESS_SCHEMES } from "@ai-sidekicks/contracts";

import { classifyNavigation, openExternalUrl, type InWindowOrigin } from "./navigation.js";

const RENDERER_ORIGINS: readonly InWindowOrigin[] = [
  { protocol: "sidekicks-renderer:", host: "app" },
];

describe("classifyNavigation", () => {
  it("admits a hash route on that origin", () => {
    expect(
      classifyNavigation(
        "sidekicks-renderer://app/index.html#/session/0f1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d",
        RENDERER_ORIGINS,
      ),
    ).toEqual({ kind: "in-window" });
  });

  // The `.origin` trap: both parse to `origin === "null"`.
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

  it("classifies the web-address schemes as external", () => {
    for (const protocol of WEB_ADDRESS_SCHEMES) {
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
});

describe("openExternalUrl", () => {
  beforeEach(() => {
    shellMock.reset();
  });

  it("opens a web address", async () => {
    await openExternalUrl("https://example.test/docs");

    expect(shellMock.openedUrls).toEqual(["https://example.test/docs"]);
  });

  // The re-check is the point: this is the single place a URL reaches `shell.openExternal`.
  it("rejects and opens nothing for a target that is not a web address", async () => {
    await expect(openExternalUrl("file:///etc/passwd")).rejects.toThrow(
      "navigation target is outside every allowed scheme",
    );
    expect(shellMock.openedUrls).toEqual([]);
  });

  it("rejects and opens nothing for a web address carrying credentials", async () => {
    await expect(openExternalUrl("https://app@evil.test/looks-like-app")).rejects.toThrow(
      "navigation target carries credentials",
    );
    expect(shellMock.openedUrls).toEqual([]);
  });
});
