// Settings › Browser's wire: a site is named by its http(s) origin and never by an
// address carrying credentials or a path, and the Chromium reading says when it was
// fetched only for the fetched one.
import { describe, expect, it } from "vitest";

import {
  BrowserChromiumReadResponseSchema,
  BrowserSiteDataListResponseSchema,
  BrowserSiteRequestSchema,
} from "../browser.js";

describe("a site's origin", () => {
  it("accepts an http(s) origin, with a port where it is not the scheme's own", () => {
    for (const origin of [
      "https://example.com",
      "http://localhost:5173",
      "http://127.0.0.1:3000",
    ]) {
      expect(BrowserSiteRequestSchema.safeParse({ origin }).success).toBe(true);
    }
  });

  it("refuses credentials, another scheme, a path, a default port spelled out, and words", () => {
    for (const origin of [
      "https://user@example.com",
      "https://user:secret@example.com",
      "file:///etc/passwd",
      "ftp://example.com",
      "https://example.com/account",
      "https://example.com:443",
      "example.com",
      "not an origin",
    ]) {
      expect(BrowserSiteRequestSchema.safeParse({ origin }).success).toBe(false);
    }
  });
});

describe("browser.siteDataList", () => {
  it("says of each site whether it holds a cookie", () => {
    const site = {
      origin: "https://example.com",
      sizeBytes: 2048,
      lastUsedAt: "2026-09-29T10:00:00Z",
      hasCookies: true,
    };
    expect(BrowserSiteDataListResponseSchema.safeParse({ sites: [site] }).success).toBe(true);
    const { hasCookies: _hasCookies, ...withoutCookieFact } = site;
    expect(
      BrowserSiteDataListResponseSchema.safeParse({ sites: [withoutCookieFact] }).success,
    ).toBe(false);
    expect(
      BrowserSiteDataListResponseSchema.safeParse({ sites: [{ ...site, signedIn: true }] }).success,
    ).toBe(false);
  });
});

describe("browser.chromiumRead", () => {
  it("dates only the fetched Chromium", () => {
    const fetched = {
      source: "playwright",
      version: "141.0.7390.54",
      fetchedAt: "2026-09-12T09:00:00Z",
      cannotStart: null,
    };
    const installed = { source: "chrome", version: "141", fetchedAt: null, cannotStart: null };
    expect(BrowserChromiumReadResponseSchema.safeParse(fetched).success).toBe(true);
    expect(BrowserChromiumReadResponseSchema.safeParse(installed).success).toBe(true);
    expect(
      BrowserChromiumReadResponseSchema.safeParse({ ...fetched, fetchedAt: null }).success,
    ).toBe(false);
    expect(
      BrowserChromiumReadResponseSchema.safeParse({
        ...installed,
        fetchedAt: "2026-09-12T09:00:00Z",
      }).success,
    ).toBe(false);
  });

  it("says why the headless Chromium cannot start, from a closed set", () => {
    const reading = {
      source: "playwright",
      version: "141.0.7390.54",
      fetchedAt: "2026-09-12T09:00:00Z",
      cannotStart: {
        reason: "missingSystemLibraries",
        installStep: "sudo npx playwright@1.62.1 install-deps chromium",
      },
    };
    expect(BrowserChromiumReadResponseSchema.safeParse(reading).success).toBe(true);
    expect(
      BrowserChromiumReadResponseSchema.safeParse({
        ...reading,
        cannotStart: { ...reading.cannotStart, reason: "noDisplay" },
      }).success,
    ).toBe(false);
  });
});
