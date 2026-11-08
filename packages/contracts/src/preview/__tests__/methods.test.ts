// The Preview wire as the renderer and the daemon both parse it: a page list whose active index
// names a page.
import { describe, expect, it } from "vitest";

import { PreviewPageListFrameSchema, type PreviewPage, type PreviewPageId } from "../methods.js";

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
