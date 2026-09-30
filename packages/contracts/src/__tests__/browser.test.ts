// Settings › Browser's wire: a site is named by its http(s) origin and never by an
// address carrying credentials or a path, and the Chromium reading says when it was
// fetched only for the fetched one.
import { describe, expect, it } from "vitest";

import { BrowserChromiumReadResponseSchema, BrowserSiteRequestSchema } from "../browser.js";

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
});
