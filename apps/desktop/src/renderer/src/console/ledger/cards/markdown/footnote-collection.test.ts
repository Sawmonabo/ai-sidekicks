// Finding definitions without rendering them — the split that keeps the mapper pure.

import { describe, expect, it } from "vitest";

import { collectFootnoteDefinitions, collectFootnoteReferences } from "./footnote-collection.js";
import { parseSettledBlock } from "./markdown-parse.js";

describe("collecting a message's footnote definitions", () => {
  it("finds a definition and reports its identifier", () => {
    const { definitions, definedIdentifiers } = collectFootnoteDefinitions(
      parseSettledBlock("[^note]: the body\n").children,
    );
    expect(definitions).toHaveLength(1);
    expect(definedIdentifiers.has("note")).toBe(true);
  });

  it("reports the same set the definitions carry, so the two cannot disagree", () => {
    const { definitions, definedIdentifiers } = collectFootnoteDefinitions(
      parseSettledBlock("[^a]: one\n\n[^b]: two\n").children,
    );
    expect([...definedIdentifiers].sort()).toStrictEqual(
      definitions.map((definition) => definition.identifier).sort(),
    );
  });

  it("negative control: a REFERENCE is not a definition", () => {
    // Without this, a walk that matched on the word "footnote" would report a message
    // that only cites a note as one that defines it, and every marker would claim a body.
    const { definitions, definedIdentifiers } = collectFootnoteDefinitions(
      parseSettledBlock("see the note[^1]\n").children,
    );
    expect(definitions).toStrictEqual([]);
    expect(definedIdentifiers.size).toBe(0);
  });
});

describe("collecting the identifiers a message refers to", () => {
  it("finds a reference nested inside a block", () => {
    // The walk has to be deep because a `[^1]` lives wherever a word can — here inside a
    // list item inside a quote, which the shallow definition walk would never reach.
    const referenced = collectFootnoteReferences(
      parseSettledBlock("> - see the note[^1]\n\n[^1]: the body\n").children,
    );
    expect([...referenced]).toStrictEqual(["1"]);
  });

  it("counts a reference made from inside another definition's body", () => {
    // A pair of notes that cite each other are both referred to, so neither is uncited.
    const referenced = collectFootnoteReferences(
      parseSettledBlock("cite[^a]\n\n[^a]: see also[^b]\n\n[^b]: the second\n").children,
    );
    expect([...referenced].sort()).toStrictEqual(["a", "b"]);
  });

  it("negative control: a DEFINITION on its own is not a reference", () => {
    // Without this, a walk that matched any footnote node would report every definition
    // as citing itself, and no message could ever hold an uncited note.
    const referenced = collectFootnoteReferences(parseSettledBlock("[^note]: the body\n").children);
    expect(referenced.size).toBe(0);
  });
});
