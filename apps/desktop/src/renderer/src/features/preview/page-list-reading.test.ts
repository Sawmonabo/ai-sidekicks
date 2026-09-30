// An empty array is both "owns no pages" and "nobody has answered yet", so the cases pair the
// served-and-empty reading with the arms that are not it.

import { describe, expect, it } from "vitest";

import type { PreviewPage } from "@ai-sidekicks/contracts";

import { pagesOf, type PageListReading } from "./page-list-reading.js";
import { previewPage } from "./page-list-reading.test-support.js";

const PAGE: PreviewPage = previewPage({
  pageId: "page-a",
  title: "Example",
  address: "https://example.test/",
});

describe("the pages a reading carries", () => {
  it("carries the served frame's pages", () => {
    const reading: PageListReading = {
      kind: "served",
      frame: { pages: [PAGE], activeIndex: 0 },
    };
    expect(pagesOf(reading)).toEqual([PAGE]);
  });

  it("carries none for a reading nobody has answered", () => {
    expect(pagesOf({ kind: "reading" })).toEqual([]);
  });

  it("carries none for an ended subscription, rather than the last frame", () => {
    // A strip drawing tabs nobody reports any more would offer close controls over gone pages.
    expect(pagesOf({ kind: "ended" })).toEqual([]);
  });

  it("negative control: a served reading with no pages is the same array as the others", () => {
    // Every caller branches on the reading, since the arms above are indistinguishable here.
    expect(pagesOf({ kind: "served", frame: { pages: [], activeIndex: -1 } })).toEqual([]);
  });
});
