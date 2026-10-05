import { MarkdownNodes, type MarkdownRenderContext } from "./MarkdownNodes.js";
import type { MarkdownDocumentRow as MarkdownDocumentRowData } from "./markdown-document-rows.js";

/**
 * One row of a document drawn on its own: its blocks, or one of its footnote definitions with its
 * label, as a list window draws them one at a time.
 */
export function MarkdownDocumentRow(props: {
  readonly row: MarkdownDocumentRowData;
  readonly context: MarkdownRenderContext;
}): React.JSX.Element {
  const { row, context } = props;
  if (row.kind === "blocks") {
    return (
      <div className="meridian-markdown meridian-markdown--row">
        <MarkdownNodes nodes={row.nodes} context={context} />
      </div>
    );
  }
  return (
    <div
      className={
        "meridian-markdown meridian-markdown--row " + "meridian-markdown__footnote-definition"
      }
    >
      <span className="meridian-markdown__footnote-label">
        {row.definition.label ?? row.definition.identifier}
      </span>
      <div className="meridian-markdown__footnote-body">
        <MarkdownNodes nodes={row.definition.children} context={context} />
      </div>
    </div>
  );
}
