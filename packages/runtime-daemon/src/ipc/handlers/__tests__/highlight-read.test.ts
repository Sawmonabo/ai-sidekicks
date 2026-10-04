// `highlight.read` through the daemon's real method registry: the colorer's spans reach the wire
// as the flat packed list.

import { describe, expect, it } from "vitest";

import { HIGHLIGHT_READ_METHOD } from "@ai-sidekicks/contracts/highlight";

import { CodeHighlighter } from "../../../highlight/code-highlighter.js";
import { MethodRegistryImpl } from "../../registry.js";
import { registerHighlightRead } from "../highlight-read.js";

const dispatchContext = { transportId: 1 };

describe("highlight.read", () => {
  it("answers with the colorer's spans as a flat list", async () => {
    const registry = new MethodRegistryImpl();
    registerHighlightRead(registry, { highlighter: new CodeHighlighter() });
    const result = await registry.dispatch(
      HIGHLIGHT_READ_METHOD,
      { language: "python", source: "def main():\n    return 7\n" },
      dispatchContext,
    );
    // `def` and `return` are keywords, `main` a name, `7` a number.
    expect(result).toStrictEqual({ spans: [0, 3, 0, 4, 4, 1, 16, 6, 0, 23, 1, 3] });
  });
});
