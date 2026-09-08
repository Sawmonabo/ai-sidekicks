// The mdast-to-React mapper — OWN-BUILD, per `Spec-023 §Console Libraries`.
//
// Every AVOIDed library on that row (react-markdown, the rehype stack, markdown-it,
// markdown-to-jsx, the Tailwind-styled streaming renderers) fails on the same axis: each
// one either renders raw HTML by default or reaches it through a plugin, and each brings
// its own class names into a design system that already has some. A mapper is a switch
// over a node union; owning it costs one file and buys both properties outright.
//
// THE THREE RULES THIS FILE ENFORCES, from `markdown-rules.ts`:
//
//   1. **`html` nodes render as literal text**, at block and inline level both. That is
//      what "Model HTML is never rendered" means concretely, and it is why NO SANITIZER
//      IS ON THIS PATH — nothing is ever parsed as markup, so there is nothing to
//      sanitise. `<script>alert(1)</script>` in a message reaches the screen as the
//      characters an author typed.
//   2. **No path links.** `markdown-rules.ts` reads the growth slate and answers `false`
//      today, so a link renders as its own text with no anchor and no href. `remend`'s
//      sentinel for an unfinished link takes the same disposition for a different reason,
//      which is why neither needs a special case here.
//   3. **Math and diagrams wait for the block to settle**, threaded as `isSettled`
//      through the context rather than decided per node.
//
// THE NODE UNION IS `mdast`'s OWN, so every arm narrows rather than casts. `mdast-util-
// gfm` merges its table, strikethrough, task-list, and footnote nodes into that union by
// declaration, which is why those arms typecheck without this file naming the extension.
//
// A NODE TYPE THIS SWITCH HAS NOT BEEN TAUGHT renders its children. mdast grows node
// types with its extensions, and an unknown one is far more likely to be a container than
// a leaf: dropping it would silently delete an author's words, and walking into it loses
// only the node's own formatting.

import type { AlignType, Nodes, PhrasingContent, RootContent, Table, TableRow } from "mdast";
import { Fragment } from "react";

import { arePathLinksRenderable, isDeferredFenceLanguage } from "./markdown-rules.js";
import { CodeBlock } from "../highlight/CodeBlock.js";
import { FootnoteReference } from "../footnotes/FootnoteReference.js";
import { MathBlock } from "./MathBlock.js";

/** Everything the mapper needs that is not the node itself. */
export interface MarkdownRenderContext {
  /**
   * Whether the containing block has settled. Decides math, diagrams, and highlighting —
   * one flag for all three, because all three are wrong when fed a prefix.
   */
  readonly isSettled: boolean;
  /**
   * Which footnote identifiers this message defined.
   *
   * A SET rather than the registry itself, and that is the point: the mapper is a pure
   * function of the parse, so it never reads or writes state during a render. The
   * registry is fed from an effect in `StreamingMarkdown`, and this set is derived from
   * the same walk.
   */
  readonly definedFootnoteIdentifiers: ReadonlySet<string>;
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
 * A node's key.
 *
 * mdast carries source positions, so a node's own start offset is a real identity: it
 * survives a re-parse of the same text and moves when the node does. The index is the
 * fallback for a node a parse produced without one.
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
      // Rule 1. The arm this whole file is arranged around.
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
      // A message's `#` is not a page title — the ledger's rows are the document's
      // structure — so every level renders as one element carrying its depth, and
      // `markdown.css` gives the levels their weights. That is what keeps a message from
      // out-shouting the surface it sits inside.
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
        <li className="meridian-markdown__list-item">
          {node.checked === null || node.checked === undefined ? null : (
            // Disabled and read-only: the box is a record of what an author wrote, not a
            // control. A checkbox the console let a reader toggle would be editing
            // somebody else's message.
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
      // Rule 2. The text always survives; the anchor is what is withheld.
      return arePathLinksRenderable() && node.type === "link" ? (
        <a href={node.url} className="meridian-markdown__link">
          {renderChildren(node.children, context)}
        </a>
      ) : (
        <span className="meridian-markdown__link meridian-markdown__link--inert">
          {renderChildren(node.children, context)}
        </span>
      );
    case "image":
    case "imageReference":
      // An image is a fetch of a URL a message chose, which asks the same trust question
      // a link does and gets the same answer. The alt text is the author's words and is
      // kept.
      return <span className="meridian-markdown__image-alt">{node.alt ?? ""}</span>;
    case "table":
      return (
        <div className="meridian-markdown__table-scroll">
          <table className="meridian-markdown__table">{renderTableSections(node, context)}</table>
        </div>
      );
    case "footnoteDefinition":
      // Registered elsewhere, rendered nowhere here. This console puts footnotes in one
      // popover host per timeline, so a definition's body belongs to the popover;
      // rendering it inline as well would put the same text on the screen twice.
      return null;
    case "footnoteReference":
      // A component rather than markup inline, because the marker has to find the card's
      // popover host — and a host reached through a React context is a hook call, which
      // this switch is not allowed to make. See `footnote-popover-context.ts` for why the
      // host does not ride `MarkdownRenderContext` instead.
      return (
        <FootnoteReference
          identifier={node.identifier}
          label={node.label ?? node.identifier}
          isDefined={context.definedFootnoteIdentifiers.has(node.identifier)}
        />
      );
    default:
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
 * A GFM table's head and body, which are two things the parse already tells apart.
 *
 * THE FIRST ROW IS THE HEADER ROW — that is what the delimiter line under it declares,
 * and it is the only thing that line declares about rows. Every row used to reach the
 * screen as `<td>` inside one `<tbody>`, so a table with column names rendered as a
 * grid with none: a reader on assistive technology got cell contents with nothing to
 * announce them against, and no amount of styling would have put that back.
 *
 * THE TABLE ARM NOW OWNS ITS WHOLE SUBTREE, which is why `tableRow` and `tableCell`
 * carry no arm of their own in the switch above. Whether a cell is a header is a fact
 * about its ROW's position in the table, and whether it is aligned is a fact the TABLE
 * carries — neither is readable from the cell, so a per-cell arm could not have
 * rendered either one. A row or a cell reaching the switch from anywhere else is a
 * tree this parser does not produce, and it walks into its children like any other
 * container rather than emitting table markup outside a table.
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
 * One row of a table, with each cell told which column it is in.
 *
 * The alignment list is the TABLE's, one entry per column, so the index a cell sits at
 * is what selects its entry. A row with more cells than the delimiter line declared
 * columns reads `undefined` past the end and renders unaligned, which is what the
 * parse says about a column that was never declared.
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
 * One cell, as a header or as data, carrying the column's declared alignment.
 *
 * `data-align` rather than an inline style, on the heading arm's own precedent: the
 * parse states which of three alignments a column declared and `markdown.css` states
 * what each one looks like, so a design change is a stylesheet edit rather than a
 * mapper edit. An undeclared alignment carries no attribute at all — the sheet's own
 * default is what a column with no delimiter marker gets, and an attribute spelling
 * that default would be this mapper asserting a declaration the author never made.
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
 * A fenced block: math, a diagram, or code.
 *
 * The three are one mdast node and are told apart by the info string, which is the only
 * place any of them declares itself. `markdown-rules.ts` owns that reading, so the
 * deferral rule and this switch cannot disagree about what "mermaid" means.
 *
 * A deferred fence that is math renders as a formula once settled and as its source
 * before; a deferred fence that is a diagram renders as its source always, because this
 * console ships no control that asks for one.
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
      <CodeBlock source={source} infoString={language} isSettled={false} />
    );
  }
  return <CodeBlock source={source} infoString={language} isSettled={context.isSettled} />;
}

/** Whether a deferred fence is math rather than a diagram. */
function isMathFence(language: string | null): boolean {
  return language === "math" || language === "latex" || language === "tex";
}
