import { describe, expect, it } from "vitest";

import { collectFootnoteDefinitions } from "./footnote-collection.js";
import { parseSettledBlock } from "../parse/markdown-parse.js";

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
    // A walk matching on the word "footnote" would report a citing message as defining.
    const { definitions, definedIdentifiers } = collectFootnoteDefinitions(
      parseSettledBlock("see the note[^1]\n").children,
    );
    expect(definitions).toStrictEqual([]);
    expect(definedIdentifiers.size).toBe(0);
  });
});
