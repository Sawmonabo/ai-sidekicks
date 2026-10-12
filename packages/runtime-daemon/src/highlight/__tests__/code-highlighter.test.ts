// The colorer's two promises: a file colored line by line on its thread is colored as if in one
// piece, and code asked for twice is colored once.

import { afterEach, describe, expect, it } from "vitest";

import { CodeHighlighter } from "../code-highlighter.js";
import { decodeSpans } from "./spans.test-support.js";

let highlighter: CodeHighlighter | undefined;

afterEach(async () => {
  await highlighter?.stop();
  highlighter = undefined;
});

describe("CodeHighlighter", () => {
  it("colors a comment that runs past a slice boundary, and the code after it", async () => {
    const commentBody = "inside the comment\n".repeat(400);
    const source = `/*\n${commentBody}*/\nconst after = 1;\n`;
    const commentHighlighter = new CodeHighlighter();
    highlighter = commentHighlighter;
    const spans = await commentHighlighter.readSpans(source, "typescript");
    const decoded = decodeSpans(source, spans);
    const commentText = decoded
      .filter(([, spanClass]) => spanClass === "comment")
      .map(([text]) => text)
      .join("\n");
    expect(commentText).toBe(`/*\n${commentBody}*/`);
    expect(decoded.slice(-2)).toStrictEqual([
      ["const", "keyword"],
      ["1", "number"],
    ]);
  });

  it("answers a second read of the same code from the first", async () => {
    const sqlHighlighter = new CodeHighlighter();
    highlighter = sqlHighlighter;
    const source = "SELECT id FROM sessions WHERE id = 7;";
    const [first, concurrent] = await Promise.all([
      sqlHighlighter.readSpans(source, "sql"),
      sqlHighlighter.readSpans(source, "sql"),
    ]);
    expect(concurrent).toBe(first);
    expect(await sqlHighlighter.readSpans(source, "sql")).toBe(first);
    expect(await sqlHighlighter.readSpans(source, "typescript")).not.toBe(first);
  });
});
