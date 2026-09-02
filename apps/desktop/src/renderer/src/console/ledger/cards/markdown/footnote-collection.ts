// Finding a message's footnote definitions, without rendering anything.
//
// The mapper is a pure function of the parse — it reads no state and writes none, which
// is what `apps/desktop/AGENTS.md` means by "React components are function components
// that render". Footnotes are the one construct that would have broken that rule the
// obvious way: a definition arrives inside the tree and belongs to a popover somewhere
// else, so the naive mapper registers it as it walks.
//
// This module is the other half of that split. One walk over the parsed nodes yields
// both things the card needs — the definitions to register from an effect, and the set
// of identifiers the mapper checks to decide whether a reference has a body — so the
// two can never disagree about what this message defined.
//
// THE WALK IS SHALLOW ON PURPOSE. GFM puts a footnote definition at the top level of a
// document; it cannot be nested inside a paragraph or a list item. Walking the whole tree
// would find nothing more and would cost a full traversal per frame on the volatile tail.

import type { FootnoteDefinition as MdastFootnoteDefinition, RootContent } from "mdast";

/** What one walk found. */
export interface FootnoteCollection {
  readonly definitions: readonly MdastFootnoteDefinition[];
  /** The identifiers those definitions declared, for the mapper's reference arm. */
  readonly definedIdentifiers: ReadonlySet<string>;
}

/** Every footnote definition among these top-level nodes. */
export function collectFootnoteDefinitions(nodes: readonly RootContent[]): FootnoteCollection {
  const definitions = nodes.filter(isFootnoteDefinition);
  return {
    definitions,
    definedIdentifiers: new Set(definitions.map((definition) => definition.identifier)),
  };
}

function isFootnoteDefinition(node: RootContent): node is MdastFootnoteDefinition {
  return node.type === "footnoteDefinition";
}
