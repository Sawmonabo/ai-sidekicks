// What one generation of a body's blocks defines, and the preamble each block is parsed after. A
// block that could define a footnote or a link is read alone, once, for the footnote identifiers
// and link reference definitions it holds; the tail is read as it grows. A settled block is parsed
// after the footnote identifiers the body declares and the link labels' first definitions in the
// body's order that its own labels may reference, as a whole-document parse resolves them, less
// the labels whose first definition is in the block itself, which its own text defines. The tail,
// parsed again as it grows, is parsed after every one of them, so its preamble holds while it
// streams.

import type { Definition, Root } from "mdast";

import { collectFootnoteDefinitions } from "#renderer/components/Markdown/footnotes/collection.js";
import {
  definitionPreambleOf,
  linkDefinitionsOf,
  referenceKeyOf,
} from "#renderer/components/Markdown/parse/definition-preamble.js";
import { type BlockRecords } from "../block-records.js";

/** What one block, or the tail, defines. */
export interface ReadDefinitions {
  readonly footnoteIdentifiers: ReadonlySet<string>;
  /** Its link reference definitions, in the order they stand in it. */
  readonly links: readonly Definition[];
}

/**
 * The definitions a body's blocks are drawn with, for one frame: the same object while nothing a
 * block or the tail defines changed.
 */
export interface DefinitionsView {
  /** Every footnote identifier the body declares: the same set until one is added or removed. */
  readonly definedFootnoteIdentifiers: ReadonlySet<string>;
  /** The settled blocks that define a footnote, ascending. */
  readonly definingBlocks: readonly number[];
  /**
   * Every definition the body declares, restated: the preamble the tail is parsed after while it
   * defines no label first, and a string that changes whenever any definition does.
   */
  readonly commonPreamble: string;
  /** The preamble the tail is parsed after: without the labels the tail defines first. */
  readonly tailPreamble: string;
  /** The preamble settled block `index` is parsed after. */
  readonly preambleOf: (index: number) => string;
}

/**
 * One generation's definitions: what each settled block that could define one defines, once read,
 * and the views the tail's definitions make with them.
 */
export class BodyDefinitions {
  /** The generation's blocks, whose reference keys pick each block's definitions. */
  readonly #records: BlockRecords;
  /** What each read block that defines anything defines, by its index. */
  readonly #byBlock = new Map<number, ReadDefinitions>();
  readonly #unread = new Set<number>();
  #settled: SettledDefinitions | undefined;
  #view: { readonly tailKey: string; readonly view: DefinitionsView } | undefined;

  public constructor(records: BlockRecords) {
    this.#records = records;
  }

  /** The settled blocks that could define something and are not read yet. */
  public get unread(): ReadonlySet<number> {
    return this.#unread;
  }

  /** Marks settled block `index`, which could define something, as waiting to be read. */
  public markUnread(index: number): void {
    this.#unread.add(index);
  }

  /** Takes what block `index` defines from `root`, its tree parsed alone. */
  public read(index: number, root: Root): void {
    if (!this.#unread.delete(index)) {
      return;
    }
    const read = definitionsOf(root);
    if (read.footnoteIdentifiers.size > 0 || read.links.length > 0) {
      this.#byBlock.set(index, read);
      this.#settled = undefined;
    }
  }

  /** Forgets every block from `count` on, which the cut gave back to the tail. */
  public dropFrom(count: number): void {
    for (const index of [...this.#unread]) {
      if (index >= count) {
        this.#unread.delete(index);
      }
    }
    for (const index of [...this.#byBlock.keys()]) {
      if (index >= count) {
        this.#byBlock.delete(index);
        this.#settled = undefined;
      }
    }
  }

  /** The view the settled blocks' definitions make with `tail`'s. */
  public withTail(tail: ReadDefinitions): DefinitionsView {
    const settled = (this.#settled ??= settledDefinitionsOf(this.#byBlock));
    const tailKey = keyOf(tail);
    const held = this.#view;
    if (held !== undefined && held.view === settled.lastView && held.tailKey === tailKey) {
      return held.view;
    }
    const view = viewOf(settled, tail, this.#records);
    settled.lastView = view;
    this.#view = { tailKey, view };
    return view;
  }
}

/** What `root`, a block or a tail parsed alone, defines. */
export function definitionsOf(root: Root): ReadDefinitions {
  const footnoteIdentifiers = collectFootnoteDefinitions(root.children).definedIdentifiers;
  const links = linkDefinitionsOf(root.children);
  return footnoteIdentifiers.size === 0 && links.length === 0
    ? NO_DEFINITIONS
    : { footnoteIdentifiers, links };
}

/** What a text defining nothing defines. */
export const NO_DEFINITIONS: ReadDefinitions = Object.freeze({
  footnoteIdentifiers: new Set<string>(),
  links: Object.freeze([]),
});

/** What the read settled blocks define together, worked out once per change. */
interface SettledDefinitions {
  readonly footnoteIdentifiers: ReadonlySet<string>;
  readonly definingBlocks: readonly number[];
  /** Each link label's first definition among the settled blocks, in the body's order. */
  readonly firstLinks: ReadonlyMap<string, FirstLinkDefinition>;
  /** The labels each block holds the first definition of, by its index. */
  readonly firstLabelsByBlock: ReadonlyMap<number, ReadonlySet<string>>;
  /** The view last made from these, which a tail defining the same keeps. */
  lastView: DefinitionsView | undefined;
}

/** A link label's first definition, and the block it stands in. */
interface FirstLinkDefinition {
  readonly blockIndex: number;
  readonly definition: Definition;
}

function settledDefinitionsOf(byBlock: ReadonlyMap<number, ReadDefinitions>): SettledDefinitions {
  const blockIndices = [...byBlock.keys()].sort((left, right) => left - right);
  const footnoteIdentifiers = new Set<string>();
  const definingBlocks: number[] = [];
  const firstLinks = new Map<string, FirstLinkDefinition>();
  const firstLabelsByBlock = new Map<number, Set<string>>();
  for (const blockIndex of blockIndices) {
    const read = byBlock.get(blockIndex) ?? NO_DEFINITIONS;
    if (read.footnoteIdentifiers.size > 0) {
      definingBlocks.push(blockIndex);
      for (const identifier of read.footnoteIdentifiers) {
        footnoteIdentifiers.add(identifier);
      }
    }
    for (const definition of read.links) {
      if (firstLinks.has(definition.identifier)) {
        continue;
      }
      firstLinks.set(definition.identifier, { blockIndex, definition });
      const labels = firstLabelsByBlock.get(blockIndex) ?? new Set<string>();
      labels.add(definition.identifier);
      firstLabelsByBlock.set(blockIndex, labels);
    }
  }
  return {
    footnoteIdentifiers: footnoteIdentifiers.size === 0 ? NO_IDENTIFIERS : footnoteIdentifiers,
    definingBlocks,
    firstLinks,
    firstLabelsByBlock,
    lastView: undefined,
  };
}

function viewOf(
  settled: SettledDefinitions,
  tail: ReadDefinitions,
  records: BlockRecords,
): DefinitionsView {
  const tailOnlyFootnotes = [...tail.footnoteIdentifiers].filter(
    (identifier) => !settled.footnoteIdentifiers.has(identifier),
  );
  const definedFootnoteIdentifiers =
    tailOnlyFootnotes.length === 0
      ? settled.footnoteIdentifiers
      : new Set([...settled.footnoteIdentifiers, ...tailOnlyFootnotes]);
  const settledLinks = [...settled.firstLinks.values()].map((first) => first.definition);
  const tailFirstLinks: Definition[] = [];
  const tailLabels = new Set<string>();
  for (const definition of tail.links) {
    if (!settled.firstLinks.has(definition.identifier) && !tailLabels.has(definition.identifier)) {
      tailLabels.add(definition.identifier);
      tailFirstLinks.push(definition);
    }
  }
  const allLinks = [...settledLinks, ...tailFirstLinks];
  const commonPreamble = definitionPreambleOf(definedFootnoteIdentifiers, allLinks);
  const footnoteKeys = [...definedFootnoteIdentifiers].map(
    (identifier) => [identifier, referenceKeyOf(`^${identifier}`)] as const,
  );
  const linkKeys = allLinks.map(
    (definition) => [definition, referenceKeyOf(definition.identifier)] as const,
  );
  const blockPreambles = new Map<number, string>();
  return {
    definedFootnoteIdentifiers,
    definingBlocks: settled.definingBlocks,
    commonPreamble,
    tailPreamble:
      tailFirstLinks.length === 0
        ? commonPreamble
        : definitionPreambleOf(definedFootnoteIdentifiers, settledLinks),
    preambleOf: (index) => {
      if (commonPreamble === "") {
        return "";
      }
      let preamble = blockPreambles.get(index);
      if (preamble === undefined) {
        const references = new Set(records.referenceKeysOf(index));
        const ownLabels = settled.firstLabelsByBlock.get(index);
        preamble = definitionPreambleOf(
          new Set(
            footnoteKeys.filter(([, key]) => references.has(key)).map(([identifier]) => identifier),
          ),
          linkKeys
            .filter(
              ([definition, key]) => references.has(key) && !ownLabels?.has(definition.identifier),
            )
            .map(([definition]) => definition),
        );
        blockPreambles.set(index, preamble);
      }
      return preamble;
    },
  };
}

/**
 * What a tail defines as one comparable string, so a tail defining the same as the last keeps its
 * view. NUL joins, since the parser reads a NUL in a label as U+FFFD.
 */
function keyOf(tail: ReadDefinitions): string {
  if (tail === NO_DEFINITIONS) {
    return "";
  }
  return [
    ...[...tail.footnoteIdentifiers].sort(),
    "",
    ...tail.links.map((definition) =>
      JSON.stringify([definition.identifier, definition.url, definition.title]),
    ),
  ].join("\u0000");
}

const NO_IDENTIFIERS: ReadonlySet<string> = new Set<string>();
