// `pagesOf`, and the sentence it refuses to say.
//
// The whole reason this helper exists rather than a ternary at three call sites is
// that "this session owns no pages" and "nobody has answered yet" are different
// claims, and an empty array is the shape both would take. So the cases below pair
// the served-and-empty reading with the three arms that are NOT it, and each caller
// still branches on the reading itself — which is what the surfaces' own suites
// assert.

import { describe, expect, it } from "vitest";

import { refuse } from "../../core/index.js";
import { pagesOf, type BrowserPage, type PageListReading } from "./page-state.js";

const PAGE: BrowserPage = {
  pageId: "page-a",
  label: null,
  title: "Example",
  url: "https://example.test/",
  host: "example.test",
  isLoading: false,
  isSelected: true,
  isShown: true,
};

describe("the pages a reading carries", () => {
  it("carries the served frame's pages", () => {
    const reading: PageListReading = {
      kind: "served",
      frame: { contextName: "Research", pages: [PAGE] },
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

  it("carries none for a refused subscription", () => {
    expect(
      pagesOf({
        kind: "refused",
        scope: "whole-answer",
        refusal: refuse("browser-pages", "page-subscription-failed", "The subscription broke."),
      }),
    ).toEqual([]);
  });

  it("negative control: a served reading with no pages is the same array as the others", () => {
    // Which is exactly why every caller branches on the READING and not on this
    // result: the four arms above are indistinguishable here by construction.
    expect(pagesOf({ kind: "served", frame: { contextName: null, pages: [] } })).toEqual([]);
  });
});
