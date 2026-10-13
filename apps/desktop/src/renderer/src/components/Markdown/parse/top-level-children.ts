// Where a text's top-level children sit, read off the parser's tree without reading the tree
// itself: the root's child ids and types, then the position of each node of those types, both
// walked inside the parser. Copying the whole tree out would hold its bytes in the parser's
// memory, which never shrinks; the walk copies out only what the cut reads. The text is parsed as
// the screen's trees are, with the same features and each NUL replaced; a dollar read as text is
// left as it is, since which dollars open a formula is read inside a block, after the text is cut
// into blocks, and moves no block's bounds.

import { createMdastHandle, dropHandle, walkMdastHandle } from "satteri";
import { NodeType } from "satteri/mdast-reader";

import type { TopLevelChildren } from "./block-cut.js";
import { MARKDOWN_FEATURES, withoutNul } from "./serialized-tree.js";

/** Where each top-level child of `source` starts and ends, in UTF-16 code units of it. */
export function readTopLevelChildren(source: string): TopLevelChildren {
  const handle = createMdastHandle(withoutNul(source), MARKDOWN_FEATURES, true);
  try {
    const children = rootChildrenOf(
      walkMdastHandle(handle, [{ nodeType: NodeType.Root, tagFilter: [] }]),
    );
    const childMatches = walkMdastHandle(
      handle,
      [...new Set(children.types)].map((nodeType) => ({ nodeType, tagFilter: [] })),
    );
    return positionsOf(children.ids, childMatches);
  } finally {
    // The handle holds the parse's arena inside the parser's memory until it is dropped.
    dropHandle(handle);
  }
}

/** The root's children as a walk reads them: their node ids and their types, in order. */
interface RootChildren {
  readonly ids: Uint32Array;
  readonly types: Uint8Array;
}

/**
 * Each walk's answer opens on its match count, then 10 bytes a match: the node's id, the
 * subscription it matched, a byte unused here, and where its data starts.
 */
const MATCH_COUNT_BYTES = 4;
const MATCH_ENTRY_BYTES = 10;
const MATCH_DATA_OFFSET_AT = 6;
/** A node's data opens on its JSON's length and JSON, then its position's 24 bytes. */
const DATA_LENGTH_BYTES = 4;
const POSITION_BYTES = 24;
/** Within a position: its start offset, its end offset, then its start line, 0 for none. */
const POSITION_END_OFFSET_AT = 4;
const POSITION_START_LINE_AT = 8;

/** The root's children from the walk that matched the root alone. */
function rootChildrenOf(rootMatch: Uint8Array): RootChildren {
  const view = viewOf(rootMatch);
  if (view.getUint32(0, true) !== 1) {
    throw new Error("The markdown parser's walk did not match the root once");
  }
  const childCountAt =
    positionAt(view, view.getUint32(MATCH_COUNT_BYTES + MATCH_DATA_OFFSET_AT, true)) +
    POSITION_BYTES;
  const count = view.getUint32(childCountAt, true);
  const idsAt = childCountAt + 4;
  const typesAt = idsAt + 4 * count;
  const ids = new Uint32Array(count);
  for (let index = 0; index < count; index += 1) {
    ids[index] = view.getUint32(idsAt + 4 * index, true);
  }
  return { ids, types: rootMatch.slice(typesAt, typesAt + count) };
}

/**
 * Where each child in `ids` starts and ends, from a walk that matched every node of their types.
 */
function positionsOf(ids: Uint32Array, childMatches: Uint8Array): TopLevelChildren {
  const placeOf = new Map<number, number>();
  for (const [index, id] of ids.entries()) {
    placeOf.set(id, index);
  }
  const starts = new Uint32Array(ids.length);
  const ends = new Uint32Array(ids.length);
  const found = new Uint8Array(ids.length);
  const view = viewOf(childMatches);
  const matchCount = view.getUint32(0, true);
  for (let match = 0; match < matchCount; match += 1) {
    const entryAt = MATCH_COUNT_BYTES + MATCH_ENTRY_BYTES * match;
    const place = placeOf.get(view.getUint32(entryAt, true));
    if (place === undefined) {
      continue;
    }
    const at = positionAt(view, view.getUint32(entryAt + MATCH_DATA_OFFSET_AT, true));
    if (view.getUint32(at + POSITION_START_LINE_AT, true) === 0) {
      throw new Error("The markdown parser gave a top-level child no position");
    }
    starts[place] = view.getUint32(at, true);
    ends[place] = view.getUint32(at + POSITION_END_OFFSET_AT, true);
    found[place] = 1;
  }
  if (found.includes(0)) {
    throw new Error("The markdown parser's walk missed a top-level child");
  }
  return { starts, ends };
}

/** Where the position of the node whose data starts at `dataAt` sits. */
function positionAt(view: DataView, dataAt: number): number {
  return dataAt + DATA_LENGTH_BYTES + view.getUint32(dataAt, true);
}

function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}
