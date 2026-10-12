// Turns what the parser made of some text back into the text it was written as, as micromark
// reads it. A pair of single tildes is never strikethrough, though GFM allows it, so a figure
// like `~240MB` and a later `~5%` never strike what lies between them. A literal autolink GFM does
// not make stays text: `http://…` with no domain after it, or a `www.` right after a letter or
// an emoji. A dollar the worker read as text, under a stand-in, is a dollar again.

import type { Nodes, Parents, RootContent, Text } from "mdast";

/**
 * `tree` with every strikethrough a single tilde opened, and every literal autolink GFM does not
 * allow, made the text it was parsed from, and each `dollarStandIn` a dollar. `parsedText` is the
 * text the tree's offsets count in. Changes `tree` in place and returns it.
 */
export function restoreLiteralText<Tree extends Parents>(
  tree: Tree,
  parsedText: string,
  dollarStandIn: string | undefined,
): Tree {
  if (dollarStandIn !== undefined) {
    restoreDollars(tree, dollarStandIn);
  }
  if (mayHoldLiteralText(parsedText)) {
    restoreChildren(tree, parsedText);
  }
  return tree;
}

/**
 * Whether `text` may hold a single tilde or a literal autolink: the parse of text that does not
 * has nothing for `restoreLiteralText` to restore but its dollars.
 */
export function mayHoldLiteralText(text: string): boolean {
  return MAY_HOLD_RESTORABLE.test(text);
}

const MAY_HOLD_RESTORABLE = /~|www|:\/\//iu;

/**
 * The characters that may come before a `www.` autolink, as GFM's reference tokenizer allows:
 * the start of the text, whitespace, or one of `( * _ [ ] ~`.
 */
const BEFORE_WWW_AUTOLINK: ReadonlySet<string> = new Set([
  "(",
  "*",
  "_",
  "[",
  "]",
  "~",
  " ",
  "\t",
  "\n",
  "\r",
]);

/**
 * A character that would read as something other than itself once a link is text again, so
 * making the link text would not give the reference reading; such a link is left as it is.
 */
const ACTIVE_INLINE_CHARACTER = /[\\&*_~`[<\n\r]/u;

/** One node in a run of nodes that replaces another, and whether it joins the text before it. */
interface LiteralPiece {
  readonly node: RootContent;
  readonly joinsBefore: boolean;
}

/** Every `standIn` in the text and image descriptions `node` holds made a dollar again. */
function restoreDollars(node: Nodes, standIn: string): void {
  if (node.type === "text") {
    node.value = node.value.replaceAll(standIn, "$");
  } else if (node.type === "image") {
    node.alt = node.alt?.replaceAll(standIn, "$") ?? null;
  } else if ("children" in node) {
    for (const child of node.children) {
      restoreDollars(child, standIn);
    }
  }
}

function restoreChildren(parent: Parents, parsedText: string): void {
  const original = parent.children;
  // Made only once a child changes, so a tree with nothing to restore is walked, never copied.
  let children: RootContent[] | undefined;
  // Whether the next child meets text this pass wrote, and so joins it when both are text.
  let joinsNext = false;
  for (let index = 0; index < original.length; index += 1) {
    const child = original[index] as RootContent;
    if ("children" in child) {
      restoreChildren(child, parsedText);
    }
    const pieces =
      child.type === "delete" || child.type === "link"
        ? literalPiecesOf(child, original[index - 1], parsedText)
        : undefined;
    if (pieces === undefined) {
      if (children !== undefined) {
        appendJoined(children, child, joinsNext);
      }
      joinsNext = false;
      continue;
    }
    children ??= original.slice(0, index);
    for (const piece of pieces) {
      appendJoined(children, piece.node, piece.joinsBefore);
    }
    joinsNext = true;
  }
  if (children !== undefined) {
    parent.children = children as typeof parent.children;
  }
}

/** Add `child` to `children`, joined to the text before it when `joins` and both are text. */
function appendJoined(children: RootContent[], child: RootContent, joins: boolean): void {
  const previous = children.at(-1);
  if (joins && previous?.type === "text" && child.type === "text") {
    children[children.length - 1] = joinedText(previous, child);
    return;
  }
  children.push(child);
}

/** What `node` reads as when it is the text it was parsed from, or `undefined` to keep it. */
function literalPiecesOf(
  node: Extract<RootContent, { type: "delete" | "link" }>,
  previousSibling: RootContent | undefined,
  parsedText: string,
): readonly LiteralPiece[] | undefined {
  const start = node.position?.start;
  const end = node.position?.end;
  if (start?.offset === undefined || end?.offset === undefined) {
    return undefined;
  }
  if (node.type === "delete") {
    if (parsedText.charAt(start.offset + 1) === "~") {
      return undefined;
    }
    // The tildes join the text on either side, and the first and last of what they held.
    return [
      { node: tildeText(start, shiftedPoint(start, 1)), joinsBefore: true },
      ...node.children.map((inner, innerIndex) => ({ node: inner, joinsBefore: innerIndex === 0 })),
      { node: tildeText(shiftedPoint(end, -1), end), joinsBefore: true },
    ];
  }
  const literal = parsedText.slice(start.offset, end.offset);
  // micromark's tokenizer reads the code point before; its later text pass, the code unit before.
  const sourceBefore = [...parsedText.slice(Math.max(0, start.offset - 2), start.offset)].at(-1);
  if (!isDisallowedLiteralAutolink(node, literal, sourceBefore, previousSibling)) {
    return undefined;
  }
  return node.children.map((inner, innerIndex) => ({ node: inner, joinsBefore: innerIndex === 0 }));
}

/**
 * Whether `link`, written as `literal`, is a literal autolink neither of micromark's two GFM
 * readings makes: its tokenizer, which reads `sourceBefore`, and its later pass over text, which
 * reads the character before inside the text node and, after `://`, needs a domain character. A
 * `www.` link fails both on the character before; an `http://` or `https://` link fails on a
 * letter before or on no domain after.
 */
function isDisallowedLiteralAutolink(
  link: Extract<Nodes, { type: "link" }>,
  literal: string,
  sourceBefore: string | undefined,
  previousSibling: RootContent | undefined,
): boolean {
  const label =
    link.children.length === 1 && link.children[0]?.type === "text"
      ? link.children[0].value
      : undefined;
  if (label !== literal || ACTIVE_INLINE_CHARACTER.test(literal)) {
    return false;
  }
  const textBefore = previousSibling?.type === "text" ? previousSibling.value.at(-1) : undefined;
  const isTextBeforeAllowed = textBefore === undefined || /\s|\p{P}|\p{S}/u.test(textBefore);
  if (link.url === `http://${label}` && /^www/iu.test(label)) {
    return (
      sourceBefore !== undefined && !BEFORE_WWW_AUTOLINK.has(sourceBefore) && !isTextBeforeAllowed
    );
  }
  const scheme = /^https?:\/\//iu.exec(label);
  if (scheme === null || link.url !== label) {
    return false;
  }
  const firstDomainCharacter = label.charAt(scheme[0].length);
  const hasNoDomain =
    firstDomainCharacter === "" ||
    /\s/u.test(firstDomainCharacter) ||
    (/\p{P}|\p{S}/u.test(firstDomainCharacter) && !"-._".includes(firstDomainCharacter));
  const isTokenizerRefusing =
    (sourceBefore !== undefined && /[A-Za-z]/u.test(sourceBefore)) || hasNoDomain;
  const isTextPassRefusing = !isTextBeforeAllowed || !/[-.\w]/u.test(firstDomainCharacter);
  return isTokenizerRefusing && isTextPassRefusing;
}

function tildeText(start: Point, end: Point): Text {
  return { type: "text", value: "~", position: { start, end } };
}

function joinedText(first: Text, second: Text): Text {
  const start = first.position?.start;
  const end = second.position?.end;
  return {
    type: "text",
    value: first.value + second.value,
    ...(start === undefined || end === undefined ? {} : { position: { start, end } }),
  };
}

/** `point` moved `by` characters along its line. */
function shiftedPoint(point: Point, by: number): Point {
  return { line: point.line, column: point.column + by, offset: (point.offset ?? 0) + by };
}

/** One end of a node's place in the parsed text, as the parser types it. */
type Point = NonNullable<Nodes["position"]>["start"];
