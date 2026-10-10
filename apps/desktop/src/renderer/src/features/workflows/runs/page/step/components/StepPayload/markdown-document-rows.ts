// A finished markdown document drawn on its own, outside the transcript, split into rows a list
// window draws one at a time: each top-level block, each item of a top-level list on its own,
// then the document's own footnote definitions, so no definition's text is lost. The transcript
// draws definitions from its footnote registry instead, so the node mapper never draws one.

import type { FootnoteDefinition, List, RootContent } from "mdast";

import { collectFootnoteDefinitions } from "#renderer/components/Markdown/footnotes/collection.js";
import type { CodeSpanReader } from "#renderer/components/Markdown/highlight/code-span-reader.js";
import type { MarkdownRenderContext } from "#renderer/components/Markdown/MarkdownNodes.js";
import { parseSettledBlock } from "#renderer/components/Markdown/parse.js";

/** One row of a document: blocks drawn through the node mapper, or one footnote definition. */
export type MarkdownDocumentRow =
  | { readonly kind: "blocks"; readonly nodes: readonly RootContent[] }
  | { readonly kind: "footnote"; readonly definition: FootnoteDefinition };

/** A parsed document's rows, the context they are drawn in, and whether it is markdown. */
export interface ParsedMarkdownDocument {
  readonly rows: readonly MarkdownDocumentRow[];
  readonly context: MarkdownRenderContext;
  /**
   * Whether the parser found any markdown in it: anything but paragraphs of plain text. A
   * document without is text, which its rows would draw with its line breaks folded.
   */
  readonly holdsMarkdown: boolean;
}

/**
 * Parse a whole stored markdown string into its rows. It is finished, so it draws settled: its
 * code is colored and its math typeset, and its code and diagram blocks draw their own copies
 * through `renderCopy`.
 */
export function parseMarkdownDocument(
  text: string,
  codeSpanReader: CodeSpanReader,
  renderCopy: MarkdownRenderContext["renderCopy"],
): ParsedMarkdownDocument {
  const nodes = parseSettledBlock(text).children;
  const footnotes = collectFootnoteDefinitions(nodes);
  return {
    rows: [
      ...nodes.flatMap(blockRows),
      ...footnotes.definitions.map(
        (definition): MarkdownDocumentRow => ({ kind: "footnote", definition }),
      ),
    ],
    context: {
      isSettled: true,
      definedFootnoteIdentifiers: footnotes.definedIdentifiers,
      codeSpanReader,
      renderCopy,
      renderTable: undefined,
    },
    holdsMarkdown: nodes.some(
      (node) => node.type !== "paragraph" || node.children.some((child) => child.type !== "text"),
    ),
  };
}

/**
 * One top-level node's rows. A list gives one row per item, each a one-item list numbered where
 * the item stands, so a long list is windowed like any other run of blocks.
 */
function blockRows(node: RootContent): MarkdownDocumentRow[] {
  if (node.type === "footnoteDefinition") {
    // Drawn after the blocks, as a footnote row.
    return [];
  }
  if (node.type !== "list") {
    return [{ kind: "blocks", nodes: [node] }];
  }
  return node.children.map((item, index): MarkdownDocumentRow => {
    const oneItem: List = {
      ...node,
      start: node.ordered === true ? (node.start ?? 1) + index : node.start,
      children: [item],
    };
    return { kind: "blocks", nodes: [oneItem] };
  });
}
