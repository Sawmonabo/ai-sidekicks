import "./MarkdownDocumentRow.css";

import {
  MarkdownNodes,
  type MarkdownRenderContext,
} from "#renderer/components/Markdown/MarkdownNodes.js";
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
      <div className="meridian-markdown meridian-workflow-payload__markdown-row">
        <MarkdownNodes nodes={row.nodes} context={context} />
      </div>
    );
  }
  return (
    <div className="meridian-markdown meridian-workflow-payload__footnote-definition">
      <span className="meridian-workflow-payload__footnote-label">
        {row.definition.label ?? row.definition.identifier}
      </span>
      <div className="meridian-workflow-payload__footnote-body">
        <MarkdownNodes nodes={row.definition.children} context={context} />
      </div>
    </div>
  );
}
