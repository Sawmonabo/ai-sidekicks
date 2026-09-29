// The page host's link as main and the daemon both parse it: a debugger message in
// either direction, and the cookie and site-data calls the daemon makes into main.
import { describe, expect, it } from "vitest";

import {
  PreviewPageCookiesReadRequestSchema,
  PreviewPageDebuggerMessageRequestSchema,
  PreviewPageSiteDataClearRequestSchema,
} from "../preview-page-host.js";

const PAGE_ID = "page-1";

describe("the page host's debugger link", () => {
  it("carries a command, its reply, an error and an event", () => {
    for (const message of [
      { id: 1, method: "Page.navigate", params: { url: "http://x.test/" } },
      { id: 1, result: {}, sessionId: "child-1" },
      { id: 2, error: { code: -32000, message: "Refused" } },
      { method: "Target.targetInfoChanged", params: {} },
    ]) {
      expect(
        PreviewPageDebuggerMessageRequestSchema.safeParse({ pageId: PAGE_ID, message }).success,
      ).toBe(true);
    }
  });

  it("refuses a reply that carries both a result and an error", () => {
    const message = { id: 1, result: {}, error: { code: 1, message: "x" } };
    expect(
      PreviewPageDebuggerMessageRequestSchema.safeParse({ pageId: PAGE_ID, message }).success,
    ).toBe(false);
  });
});

describe("cookie and site-data calls into main", () => {
  it("reads one domain's cookies or every site's", () => {
    expect(PreviewPageCookiesReadRequestSchema.safeParse({}).success).toBe(true);
    expect(PreviewPageCookiesReadRequestSchema.safeParse({ domain: "example.com" }).success).toBe(
      true,
    );
  });

  it("clears every site with no list, and refuses an empty list that would name none", () => {
    expect(PreviewPageSiteDataClearRequestSchema.safeParse({}).success).toBe(true);
    expect(
      PreviewPageSiteDataClearRequestSchema.safeParse({ origins: ["https://example.com"] }).success,
    ).toBe(true);
    expect(PreviewPageSiteDataClearRequestSchema.safeParse({ origins: [] }).success).toBe(false);
  });
});
