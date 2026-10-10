// Long replies for the windowed body's suites, and the viewport a suite draws one in. A reply's
// blocks are separated by blank lines and carry every kind of element; a fence settles with the
// block before it, so one block can draw more than one element.

import type { Unsubscribe } from "#shared/preload-api.js";
import { type ScrollController } from "#renderer/lib/scroll/chokepoint.js";
import { type MarkdownWindowViewport } from "../markdown/block-window/context.js";

/** A reply of at least `minimumCharacters`, cycle after cycle of every kind of block. */
export function longReplyMarkdown(minimumCharacters: number): string {
  const blocks: string[] = [];
  let length = 0;
  for (let cycle = 1; length < minimumCharacters; cycle += 1) {
    for (const block of replyCycle(cycle)) {
      blocks.push(block);
      length += block.length + 2;
    }
  }
  return blocks.join("\n\n");
}

/**
 * The viewport a suite draws a windowed body in: a scroll controller over its scroller, a row that
 * starts at the top of the content, and a selection read from the document.
 */
export function suiteWindowViewport(
  scrollController: ScrollController,
  selection: {
    readonly subscribe: (listener: () => void) => Unsubscribe;
    readonly read: () => AbstractRange | undefined;
  },
): MarkdownWindowViewport {
  return {
    scrollController,
    rowStartPx: () => 0,
    // The one row spans the scroller, and no reader follows it.
    holdsPlaceInsideRow: () => true,
    subscribeToSelection: selection.subscribe,
    readSelectionRange: selection.read,
  };
}

/** One cycle of blocks, numbered so no two cycles share a block's text. */
function replyCycle(cycle: number): readonly string[] {
  const label = String(cycle);
  return [
    `Section ${label} opens with a paragraph long enough to wrap across a few lines of the reading ` +
      `column, so its height depends on the width it is laid out at, as an agent's prose does.`,
    `## Heading ${label} sits between paragraphs`,
    `A paragraph with *emphasis*, **strong text**, \`inline code\` and a [link](https://example.com) ` +
      `in cycle ${label}, followed by a sentence that carries it onto a second line.`,
    `- first item of list ${label}\n- second item with **bold** text\n- third item`,
    `1. ordered one in cycle ${label}\n\n2. ordered two, loose\n\n3. ordered three`,
    `> A quotation in cycle ${label}, which holds a paragraph\n>\n> - and a list inside it`,
    "```ts\n" +
      `const cycle = ${label};\nfunction measure(input: string): number {\n  return input.length;\n}\n` +
      "```",
    `| Column | Value ${label} |\n| --- | --- |\n| alpha | one |\n| beta | two words |`,
    `### A smaller heading in cycle ${label}`,
    "---",
    `The cycle's last paragraph, number ${label}, closes it before the next one begins.`,
  ];
}
