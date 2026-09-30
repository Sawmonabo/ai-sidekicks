// Finds a message's footnote definitions without rendering. One walk yields both the definitions
// to register from an effect and the identifiers the mapper checks, so the two cannot disagree.
// The walk is shallow on purpose: GFM puts a definition at the top level, never nested.

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
