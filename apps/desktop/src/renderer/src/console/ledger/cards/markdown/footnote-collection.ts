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
// THE DEFINITION WALK IS SHALLOW ON PURPOSE. GFM puts a footnote definition at the top
// level of a document; it cannot be nested inside a paragraph or a list item. Walking the
// whole tree would find nothing more and would cost a full traversal per frame on the
// volatile tail.
//
// THE REFERENCE WALK CANNOT BE, AND IS PRICED ACCORDINGLY. A `[^1]` is inline: it lives
// wherever a word can, so finding one means walking the tree. That is only worth doing to
// answer ONE question — which definitions nothing in this body refers to — and only a
// FINISHED body can answer it, because a definition ahead of its reference is the
// ordinary shape of a stream. So the caller asks once the body is complete and never
// per frame, and this module states the cost rather than hiding it inside a helper that
// looks like its shallow sibling.

import type { FootnoteDefinition as MdastFootnoteDefinition, Nodes, RootContent } from "mdast";

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

/**
 * Every footnote identifier anything in these nodes refers to.
 *
 * An explicit stack rather than recursion: a pasted document nests deeply enough that the
 * depth is the message's rather than this module's, and a renderer that threw on a deep
 * list would lose the whole body to a construct an author is allowed to write.
 *
 * A definition's OWN children are walked with everything else, so a note that refers to
 * another note counts as a reference to it. That is the honest reading — the second note
 * is pointed at from inside the message — and it is what keeps a pair of mutually citing
 * definitions from both being reported as uncited.
 */
export function collectFootnoteReferences(nodes: readonly RootContent[]): ReadonlySet<string> {
  const identifiers = new Set<string>();
  const pending: Nodes[] = [...nodes];

  while (pending.length > 0) {
    const node = pending.pop();
    if (node === undefined) {
      continue;
    }
    if (node.type === "footnoteReference") {
      identifiers.add(node.identifier);
      continue;
    }
    if ("children" in node) {
      pending.push(...node.children);
    }
  }

  return identifiers;
}
