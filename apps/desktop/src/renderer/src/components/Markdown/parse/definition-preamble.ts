// The definitions a block is parsed after, so a reference in one block resolves against a
// definition in another, as a whole-document parse resolves it: the body's footnote identifiers,
// restated body-less, and its link reference definitions, each restated from its parsed node. A
// lone reference would otherwise read as its text, and no later pass can upgrade it. The preamble's
// own nodes are dropped from the tree by where they start, never by identity, since a block's own
// definition carries the same identifier as a restated one.

import type { Definition, Root, RootContent } from "mdast";

/** A link reference definition as a preamble restates it: what its parsed node holds. */
export type RestatedLinkDefinition = Pick<Definition, "identifier" | "url" | "title">;

/**
 * The preamble restating `footnoteIdentifiers` and `linkDefinitions`, one per identifier, sorted
 * so the same definitions make the same bytes and cache key; `""` when there are none, which
 * leaves a block's key unchanged.
 */
export function definitionPreambleOf(
  footnoteIdentifiers: ReadonlySet<string>,
  linkDefinitions: readonly RestatedLinkDefinition[],
): string {
  if (footnoteIdentifiers.size === 0 && linkDefinitions.length === 0) {
    return "";
  }
  const linkLines = linkDefinitions.map(linkDefinitionLineOf).sort().join("");
  const footnoteLines = [...footnoteIdentifiers]
    .sort()
    .map((identifier) => `[^${identifier}]:\n`)
    .join("");
  return linkLines + footnoteLines + PREAMBLE_TERMINATOR;
}

/** `root` without the nodes a preamble `preambleLength` long put ahead of the block's own. */
export function treeWithoutPreamble(root: Root, preambleLength: number): Root {
  return preambleLength === 0
    ? root
    : {
        ...root,
        children: root.children.filter(
          (child) => (child.position?.start.offset ?? 0) >= preambleLength,
        ),
      };
}

/**
 * Every link reference definition among `nodes`, in document order, those inside block quotes,
 * lists and footnote definitions included: a definition anywhere defines its label for the whole
 * document.
 */
export function linkDefinitionsOf(nodes: readonly RootContent[]): Definition[] {
  const definitions: Definition[] = [];
  collectLinkDefinitions(nodes, definitions);
  return definitions;
}

/**
 * What separates the synthetic definitions from the block's own text.
 *
 * A blank line is not enough: a footnote definition takes indented lines after a blank one as
 * its continuation, so it would swallow a block that opens on indented code. An HTML comment
 * at column zero ends the definition and is dropped with the preamble.
 */
const PREAMBLE_TERMINATOR = "\n<!---->\n\n";

/**
 * The characters a restated destination or title escapes: the backslash, the brackets that close a
 * destination, the quote that closes a title, and the ampersand, which would start a character
 * reference the parse already decoded.
 */
const RESTATED_PUNCTUATION = /[\\<>"&]/gu;

/**
 * One definition as a line: its identifier as its label, which the parse normalizes to itself, its
 * destination in angle brackets, which takes any text, and its title in quotes.
 */
function linkDefinitionLineOf(definition: RestatedLinkDefinition): string {
  // A label ending on a backslash would escape its own closing bracket; the trailing space the
  // parse trims keeps it a label.
  const label = definition.identifier.endsWith("\\")
    ? `${definition.identifier} `
    : definition.identifier;
  const title =
    definition.title === null || definition.title === undefined
      ? ""
      : ` "${definition.title.replaceAll(RESTATED_PUNCTUATION, "\\$&")}"`;
  return `[${label}]: <${definition.url.replaceAll(RESTATED_PUNCTUATION, "\\$&")}>${title}\n`;
}

function collectLinkDefinitions(nodes: readonly RootContent[], into: Definition[]): void {
  for (const node of nodes) {
    if (node.type === "definition") {
      into.push(node);
    } else if (
      node.type === "blockquote" ||
      node.type === "list" ||
      node.type === "listItem" ||
      node.type === "footnoteDefinition"
    ) {
      collectLinkDefinitions(node.children, into);
    }
  }
}
