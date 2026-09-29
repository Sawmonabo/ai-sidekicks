// `pagesOf` and the two claims it keeps apart.
//
// "This session owns no pages" and "nobody has answered yet" are different claims, and
// an empty array is the shape both take. So the cases pair the served-and-empty reading
// with the arms that are not it, and each caller still branches on the reading itself.

import { describe, expect, it } from "vitest";

import { pagesOf, type BrowserPage, type PageListReading } from "./page-list-reading.js";

const PAGE: BrowserPage = {
  pageId: "page-a",
  label: null,
  title: "Example",
  address: "https://example.test/",
  host: "example.test",
  isLoading: false,
  loadProgress: null,
  backDepth: 0,
  forwardDepth: 0,
};

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
    // A strip drawing tabs nobody is reporting any more offers close controls over
    // pages whose existence is a memory.
    expect(pagesOf({ kind: "ended" })).toEqual([]);
  });

  it("negative control: a served reading with no pages is the same array as the others", () => {
    // Which is why every caller branches on the reading and not on this result: the
    // arms above are indistinguishable here by construction.
    expect(pagesOf({ kind: "served", frame: { pages: [], activeIndex: -1 } })).toEqual([]);
  });
});
