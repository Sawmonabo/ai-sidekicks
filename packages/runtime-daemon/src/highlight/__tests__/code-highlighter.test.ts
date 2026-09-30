// The colorer's two promises: a file colored in slices is colored as if in one piece, and code
// asked for twice is colored once.

import { describe, expect, it } from "vitest";

import { HIGHLIGHT_SPAN_CLASSES } from "@ai-sidekicks/contracts";

import { CodeHighlighter } from "../code-highlighter.js";

/** Each span as the text it covers and the class it paints as. */
function decodeSpans(source: string, spans: Uint32Array): [string, string][] {
  const decoded: [string, string][] = [];
  for (let index = 0; index < spans.length; index += 3) {
    const offset = spans[index] ?? 0;
    const length = spans[index + 1] ?? 0;
    decoded.push([
      source.slice(offset, offset + length),
      HIGHLIGHT_SPAN_CLASSES[spans[index + 2] ?? 0] ?? "?",
    ]);
  }
  return decoded;
}

describe("CodeHighlighter", () => {
  it("paints each class at the characters it covers", async () => {
    const source = 'const greeting = "hi"; // say it\nlet count = 42;\n';
    const spans = await new CodeHighlighter().readSpans(source, "typescript");
    expect(decodeSpans(source, spans)).toStrictEqual([
      ["const", "keyword"],
      ['"hi"', "string"],
      ["// say it", "comment"],
      ["let", "keyword"],
      ["42", "number"],
    ]);
  });

  it("colors a comment that runs past a slice boundary, and the code after it", async () => {
    const commentBody = "inside the comment\n".repeat(400);
    const source = `/*\n${commentBody}*/\nconst after = 1;\n`;
    const spans = await new CodeHighlighter().readSpans(source, "typescript");
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
    const highlighter = new CodeHighlighter();
    const source = "SELECT id FROM sessions WHERE id = 7;";
    const [first, concurrent] = await Promise.all([
      highlighter.readSpans(source, "sql"),
      highlighter.readSpans(source, "sql"),
    ]);
    expect(concurrent).toBe(first);
    expect(await highlighter.readSpans(source, "sql")).toBe(first);
    expect(await highlighter.readSpans(source, "typescript")).not.toBe(first);
  });
});
