// A token opens its path only for the page it was minted for, only for the purpose it was minted
// for, and only while that page's document is loaded and the page has not gone.

import { describe, expect, it } from "vitest";

import { FilePathRefs } from "./refs.js";
import { pageOwner } from "./refs.test-support.js";

const PICKED_PATH = "/Users/person/Documents/brief.pdf";

describe("a file token", () => {
  it("is refused for a purpose it was not minted for, and taken for its own", () => {
    const refs = new FilePathRefs();
    const page = pageOwner(1);
    const imported = refs.mint(page, "import", PICKED_PATH);

    expect(() => refs.requirePath(page, imported, "open")).toThrow(TypeError);
    expect(() => refs.requirePath(page, imported, "attach")).toThrow(TypeError);
    expect(refs.requirePath(page, imported, "import")).toBe(PICKED_PATH);
  });

  it("is dropped when its page loads a new document, a reload or a crash's", () => {
    const refs = new FilePathRefs();
    const page = pageOwner(1);
    const before = refs.mint(page, "open", PICKED_PATH);

    page.navigate();

    expect(() => refs.requirePath(page, before, "open")).toThrow(TypeError);
    const after = refs.mint(page, "open", PICKED_PATH);
    expect(after).not.toBe(before);
    expect(refs.requirePath(page, after, "open")).toBe(PICKED_PATH);
  });

  it("is never taken from another page, and is dropped when its page goes", () => {
    const refs = new FilePathRefs();
    const page = pageOwner(1);
    const imported = refs.mint(page, "import", PICKED_PATH);

    expect(() => refs.requirePath(pageOwner(2), imported, "import")).toThrow(TypeError);
    page.destroy();

    expect(() => refs.requirePath(page, imported, "import")).toThrow(TypeError);
  });

  it("is never minted for a page that has gone, which would never drop it", () => {
    const refs = new FilePathRefs();
    const page = pageOwner(1);
    page.destroy();

    expect(() => refs.mint(page, "open", PICKED_PATH)).toThrow("has closed");
  });
});
