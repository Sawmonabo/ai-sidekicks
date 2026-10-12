// The colorer's promises: a file colored line by line on its thread is colored as if in one
// piece, a diff's lines and Markdown's own syntax take their classes, code asked for twice is
// colored once, and a read nobody waits for any more is never colored.

import { HIGHLIGHT_READ_REPLACED_CODE } from "@ai-sidekicks/contracts/highlight";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CodeHighlighter } from "../code-highlighter.js";
import type { TokenizeRequest } from "../thread.js";
import { decodeSpans } from "./spans.test-support.js";

// Every source this file's tokenizing threads are asked to color.
const tokenizedSources = vi.hoisted((): string[] => []);
vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:worker_threads")>();
  class RecordedWorker extends actual.Worker {
    override postMessage(...args: Parameters<typeof actual.Worker.prototype.postMessage>): void {
      tokenizedSources.push((args[0] as TokenizeRequest).source);
      super.postMessage(...args);
    }
  }
  return { ...actual, Worker: RecordedWorker };
});

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

  it("colors a diff's lines and Markdown's own syntax, signs and marks included", async () => {
    const markupHighlighter = new CodeHighlighter();
    highlighter = markupHighlighter;
    const diff = "--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n same\n-old\n+new\n";
    expect(decodeSpans(diff, await markupHighlighter.readSpans(diff, "diff"))).toStrictEqual([
      ["--- a/x", "deleted"],
      ["+++ b/x", "inserted"],
      ["@@ -1,2 +1,2 @@", "hunk"],
      ["-old", "deleted"],
      ["+new", "inserted"],
    ]);
    const markdown =
      "# Title\n\nSome *soft* and **firm** text, `code` and a [link](https://x.y).\n";
    expect(
      decodeSpans(markdown, await markupHighlighter.readSpans(markdown, "markdown")),
    ).toStrictEqual([
      ["# Title", "heading"],
      ["*soft*", "emphasis"],
      ["**firm**", "emphasis"],
      ["`code`", "inline-code"],
      ["link", "string"],
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

  it("colors only what a read still waits for: once per code, the newest per block", async () => {
    const boundHighlighter = new CodeHighlighter();
    highlighter = boundHighlighter;
    const read = (source: string, transportId: number, blockId: string): Promise<Uint32Array> =>
      boundHighlighter.readSpans(source, "typescript", { transportId, blockId });
    const settled = (reading: Promise<Uint32Array>): Promise<unknown> =>
      reading.then(
        () => "colored",
        (error: unknown) => (error as { code?: string }).code ?? (error as Error).message,
      );
    tokenizedSources.length = 0;

    // The first read holds the thread while the rest wait.
    const running = read("const a = 1;", 1, "a");
    const replaced = read("const b = 1;", 1, "b");
    const sharing = read("const b = 1;", 1, "c");
    const replacing = read("const b = 2;", 1, "b");
    const unwanted = read("const d = 1;", 1, "d");
    const newest = read("const d = 2;", 1, "d");
    const closed = read("const e = 1;", 2, "e");
    boundHighlighter.dropReadsOf(2);

    expect(
      await Promise.all(
        [running, replaced, sharing, replacing, unwanted, newest, closed].map(settled),
      ),
    ).toStrictEqual([
      "colored",
      HIGHLIGHT_READ_REPLACED_CODE,
      "colored",
      "colored",
      HIGHLIGHT_READ_REPLACED_CODE,
      "colored",
      "The connection that asked for the colors has closed",
    ]);
    // A replaced read another block shares is colored for that block; one nobody shares is not.
    expect(tokenizedSources).toStrictEqual([
      "const a = 1;",
      "const b = 1;",
      "const b = 2;",
      "const d = 2;",
    ]);
  });
});
