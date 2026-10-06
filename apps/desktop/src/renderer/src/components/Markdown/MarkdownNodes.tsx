// Maps mdast nodes to React elements; own-built because the libraries considered render raw HTML
// by default. `html` nodes render as literal text (nothing is parsed as markup, so no sanitizer
// is on this path), links render as their text with no anchor, and math and diagrams wait for
// `isSettled`.

import "./markdown.css";

import type { AlignType, Nodes, PhrasingContent, RootContent, Table, TableRow } from "mdast";
import { Fragment } from "react";

import { isDeferredFenceLanguage } from "./markdown-rules.js";
import type { CodeSpanReader } from "./highlight/code-span-reader.js";
import { CodeBlock } from "./highlight/CodeBlock.js";
import { FootnoteReference } from "./footnotes/FootnoteReference.js";
import { MathBlock } from "./MathBlock.js";

/** Everything the mapper needs that is not the node itself. */
export interface MarkdownRenderContext {
  /**
   * Whether the containing block has settled. Decides math, diagrams and highlighting, all of
   * which are wrong when fed a prefix.
   */
  readonly isSettled: boolean;
  /**
   * Which footnote identifiers this message defined. A set, not the registry, so the mapper
   * stays a pure function of the parse and never reads or writes state during render.
   */
  readonly definedFootnoteIdentifiers: ReadonlySet<string>;
  /** Where a settled code block's colors come from. */
  readonly codeSpanReader: CodeSpanReader;
  /**
   * Draws a code block's own Copy for its source, or `undefined` for a body whose blocks offer
   * none. Required, so a body that forgot it fails to compile rather than reading as a choice.
   */
  readonly renderCodeCopy: ((source: string) => React.ReactNode) | undefined;
}

/** Render a document's top-level children. The entry point every card uses. */
export function MarkdownNodes(props: {
  readonly nodes: readonly RootContent[];
  readonly context: MarkdownRenderContext;
}): React.JSX.Element {
  return (
    <>
      {props.nodes.map((node, index) => (
        <Fragment key={nodeKey(node, index)}>{renderNode(node, props.context)}</Fragment>
      ))}
    </>
  );
}

/**
 * A node's key: its source start offset survives a re-parse of the same text and moves with
 * the node; the index is the fallback for a node without a position.
 */
function nodeKey(node: Nodes, index: number): string {
  const offset = node.position?.start.offset;
  return offset === undefined ? `index:${String(index)}` : `offset:${String(offset)}`;
}

function renderNode(
  node: RootContent | PhrasingContent,
  context: MarkdownRenderContext,
): React.ReactNode {
  switch (node.type) {
    case "text":
      return node.value;
    case "html":
      // Model HTML renders as literal text.
      return node.value;
    case "inlineCode":
      return <code className="meridian-markdown__code">{node.value}</code>;
    case "break":
      return <br />;
    case "thematicBreak":
      return <hr className="meridian-markdown__rule" />;
    case "paragraph":
      return (
        <p className="meridian-markdown__paragraph">{renderChildren(node.children, context)}</p>
      );
    case "heading":
      // A message's `#` is not a page title, so every level is one element carrying its depth;
      // `markdown.css` gives the levels their weights.
      return (
        <p
          className="meridian-markdown__heading"
          data-depth={String(node.depth)}
          role="heading"
          aria-level={node.depth}
        >
          {renderChildren(node.children, context)}
        </p>
      );
    case "blockquote":
      return (
        <blockquote className="meridian-markdown__quote">
          {renderChildren(node.children, context)}
        </blockquote>
      );
    case "emphasis":
      return <em>{renderChildren(node.children, context)}</em>;
    case "strong":
      return <strong>{renderChildren(node.children, context)}</strong>;
    case "delete":
      return <del>{renderChildren(node.children, context)}</del>;
    case "list":
      return node.ordered === true ? (
        <ol className="meridian-markdown__list" start={node.start ?? undefined}>
          {renderChildren(node.children, context)}
        </ol>
      ) : (
        <ul className="meridian-markdown__list">{renderChildren(node.children, context)}</ul>
      );
    case "listItem":
      return (
        // A loose item says so, because its paragraphs are drawn alike either way and a copy of a
        // selection rebuilds the markdown from the drawing.
        <li
          className="meridian-markdown__list-item"
          data-spread={node.spread === true || undefined}
        >
          {node.checked === null || node.checked === undefined ? null : (
            // Disabled and read-only: the box records what an author wrote and is not a control.
            <input
              type="checkbox"
              className="meridian-markdown__task"
              checked={node.checked}
              disabled
              readOnly
              aria-label={node.checked ? "Done" : "Not done"}
            />
          )}
          {renderChildren(node.children, context)}
        </li>
      );
    case "code":
      return renderFence(node.value, node.lang ?? null, context);
    case "link":
    case "linkReference":
      // No path links. The text always survives; the anchor is what is withheld.
      return (
        <span className="meridian-markdown__link meridian-markdown__link--inert">
          {renderChildren(node.children, context)}
        </span>
      );
    case "image":
    case "imageReference":
      // An image is a fetch of a URL a message chose, the same trust question as a link. The
      // alt text is the author's words and is kept.
      return <span className="meridian-markdown__image-alt">{node.alt ?? ""}</span>;
    case "table":
      return (
        <div className="meridian-markdown__table-scroll">
          <table className="meridian-markdown__table">{renderTableSections(node, context)}</table>
        </div>
      );
    case "footnoteDefinition":
      // Drawn from the footnote registry, not inline, which would show the text twice.
      return null;
    case "footnoteReference":
      return (
        <FootnoteReference
          label={node.label ?? node.identifier}
          isDefined={context.definedFootnoteIdentifiers.has(node.identifier)}
        />
      );
    default:
      // An unknown type is likelier a container than a leaf; dropping it would delete words.
      return renderChildren(childrenOf(node), context);
  }
}

function renderChildren(
  children: readonly (RootContent | PhrasingContent)[],
  context: MarkdownRenderContext,
): React.ReactNode {
  if (children.length === 0) {
    return null;
  }
  return children.map((child, index) => (
    <Fragment key={nodeKey(child, index)}>{renderNode(child, context)}</Fragment>
  ));
}

/** A node's children, or an empty list for a leaf. The one structural read left. */
function childrenOf(node: Nodes): readonly (RootContent | PhrasingContent)[] {
  return "children" in node ? node.children : [];
}

/**
 * A GFM table's head and body. The first row is the header row, as the delimiter line under it
 * declares. The table arm owns its whole subtree, so `tableRow` and `tableCell` have no arm
 * above: whether a cell is a header depends on its row, its alignment on the table.
 */
function renderTableSections(node: Table, context: MarkdownRenderContext): React.ReactNode {
  const [headerRow, ...bodyRows] = node.children;
  return (
    <>
      {headerRow === undefined ? null : (
        <thead>{renderTableRow(headerRow, 0, node.align, "column-header", context)}</thead>
      )}
      {bodyRows.length === 0 ? null : (
        <tbody>
          {bodyRows.map((bodyRow, index) =>
            renderTableRow(bodyRow, index, node.align, "data", context),
          )}
        </tbody>
      )}
    </>
  );
}

/** Which kind of cell a row's cells are. Decided by the row, never by the cell. */
type TableCellKind = "column-header" | "data";

/**
 * One row of a table, with each cell told which column it is in. A row with more cells than the
 * delimiter line declared columns renders the extra ones unaligned.
 */
function renderTableRow(
  row: TableRow,
  rowIndex: number,
  alignments: readonly AlignType[] | null | undefined,
  cellKind: TableCellKind,
  context: MarkdownRenderContext,
): React.JSX.Element {
  return (
    <tr key={nodeKey(row, rowIndex)}>
      {row.children.map((cell, columnIndex) =>
        renderTableCell(cell, columnIndex, alignments?.[columnIndex] ?? null, cellKind, context),
      )}
    </tr>
  );
}

/**
 * One cell, as a header or as data, carrying the column's declared alignment as `data-align` so
 * `markdown.css` owns how each looks. An undeclared alignment carries no attribute, since
 * spelling the default would assert a declaration the author never made.
 */
function renderTableCell(
  cell: TableRow["children"][number],
  columnIndex: number,
  alignment: AlignType,
  cellKind: TableCellKind,
  context: MarkdownRenderContext,
): React.JSX.Element {
  const key = nodeKey(cell, columnIndex);
  const alignmentAttribute = alignment === null ? {} : { "data-align": alignment };
  return cellKind === "column-header" ? (
    <th key={key} scope="col" {...alignmentAttribute}>
      {renderChildren(cell.children, context)}
    </th>
  ) : (
    <td key={key} {...alignmentAttribute}>
      {renderChildren(cell.children, context)}
    </td>
  );
}

/**
 * A fenced block: math, a diagram, or code, told apart by the info string, which
 * `markdown-rules.ts` reads so the deferral rule and this switch agree.
 *
 * A deferred math fence renders as a formula once settled and as its source before; a diagram
 * fence renders as its source always, because the app ships no control that asks for one.
 */
function renderFence(
  source: string,
  language: string | null,
  context: MarkdownRenderContext,
): React.ReactNode {
  if (isDeferredFenceLanguage(language)) {
    return context.isSettled && isMathFence(language) ? (
      <MathBlock source={source} isDisplayMode />
    ) : (
      <CodeBlock
        source={source}
        infoString={language}
        isSettled={false}
        codeSpanReader={context.codeSpanReader}
        renderCopy={context.renderCodeCopy}
      />
    );
  }
  return (
    <CodeBlock
      source={source}
      infoString={language}
      isSettled={context.isSettled}
      codeSpanReader={context.codeSpanReader}
      renderCopy={context.renderCodeCopy}
    />
  );
}

/** Whether a deferred fence is math rather than a diagram. */
function isMathFence(language: string | null): boolean {
  return language === "math" || language === "latex" || language === "tex";
}
