// The Preview wire as the renderer and the daemon both parse it: the address rules both ends
// hold an address to, and a page list whose active index names a page.
import { describe, expect, it } from "vitest";

import { PreviewPageListFrameSchema, type PreviewPage, type PreviewPageId } from "../methods.js";
import { webAddressFault } from "../../web-address.js";

const PAGE_ID = "page-1" as PreviewPageId;

const PAGE: PreviewPage = {
  pageId: PAGE_ID,
  address: "http://localhost:5173/",
  host: "localhost:5173",
  title: "",
  favicon: null,
  loadState: { kind: "loading", progress: null },
  backDepth: 0,
  forwardDepth: 0,
  zoomFactor: 1,
  released: false,
};

describe("the address rules both ends hold an address to", () => {
  it("names a foreign scheme, and passes an http(s) address even with user or password", () => {
    expect(webAddressFault(new URL("https://app@evil.test/looks-like-app"))).toBeNull();
    expect(webAddressFault(new URL("http://user:secret@localhost:3000/"))).toBeNull();
    expect(webAddressFault(new URL("file:///etc/passwd"))).toBe("scheme");
    expect(webAddressFault(new URL("javascript:alert(1)"))).toBe("scheme");
    expect(webAddressFault(new URL("http://localhost:5173/"))).toBeNull();
    expect(webAddressFault(new URL("https://example.com/a?b"))).toBeNull();
  });
});

describe("preview.pageList frames", () => {
  it("refuses an active index past the end of the list", () => {
    expect(PreviewPageListFrameSchema.safeParse({ pages: [], activeIndex: -1 }).success).toBe(true);
    expect(PreviewPageListFrameSchema.safeParse({ pages: [PAGE], activeIndex: 0 }).success).toBe(
      true,
    );
    expect(PreviewPageListFrameSchema.safeParse({ pages: [PAGE], activeIndex: 1 }).success).toBe(
      false,
    );
    expect(PreviewPageListFrameSchema.safeParse({ pages: [], activeIndex: 0 }).success).toBe(false);
  });
});
