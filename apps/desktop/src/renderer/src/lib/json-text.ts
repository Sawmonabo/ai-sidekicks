// A value written as JSON a little at a time, so no task on the page's thread grows with it. The
// text is the one `JSON.stringify(value, null, indent)` writes; a long string is escaped a cut at a
// time, each cut by `JSON.stringify` itself, its quotes left off.

import {
  joinIntoPiecesInSlices,
  piecesOf,
  TEXT_PIECE_LENGTH,
  type PiecedText,
} from "./text-pieces.js";

/**
 * `value` as the JSON text `JSON.stringify(value, null, indent)` writes, in pieces: at once when
 * it is written inside one slice, else written in slices in `view`. `indent` counts spaces, 0 to
 * 10. A value `JSON.stringify` writes nothing for is the empty text; one it refuses, a cycle or a
 * bigint, throws the `TypeError` it throws, or rejects with it once written in slices.
 */
export function writeJsonInPieces(
  value: unknown,
  indent: number,
  view: Window,
): PiecedText | Promise<PiecedText> {
  const writing: JsonWriting = { gap: " ".repeat(indent), ancestors: new Set() };
  return joinIntoPiecesInSlices(textFragmentsOf(value, writing), view);
}

/** How a JSON text is being written: its gap, and the containers open around what is written. */
interface JsonWriting {
  readonly gap: string;
  readonly ancestors: Set<object>;
}

/**
 * The longest cut of a string escaped as one fragment: its escaped form is at most six code units
 * a unit (`\u001f`), so it stays within one piece.
 */
const STRING_CUT_LENGTH = Math.floor(TEXT_PIECE_LENGTH / 6);

/** The fragments of `value` as the whole JSON text, or none for a value JSON writes nothing for. */
function* textFragmentsOf(value: unknown, writing: JsonWriting): Generator<string> {
  const written = writtenValueOf({ "": value }, "");
  if (isWritten(written)) {
    yield* valueFragmentsOf(written, "", writing);
  }
}

/** A member's value as JSON reads it: through its `toJSON`, and unboxed. */
function writtenValueOf(holder: object, key: string): unknown {
  let value: unknown = (holder as Readonly<Record<string, unknown>>)[key];
  if ((typeof value === "object" && value !== null) || typeof value === "bigint") {
    const toJson: unknown = (value as { readonly toJSON?: unknown }).toJSON;
    if (typeof toJson === "function") {
      value = (toJson as (key: string) => unknown).call(value, key);
    }
  }
  if (value instanceof Number) {
    return Number(value);
  }
  if (value instanceof String) {
    return String(value);
  }
  if (value instanceof Boolean || value instanceof BigInt) {
    return value.valueOf();
  }
  return value;
}

/** Whether JSON writes a value: not for `undefined`, a function or a symbol. */
function isWritten(value: unknown): boolean {
  return value !== undefined && typeof value !== "function" && typeof value !== "symbol";
}

/** The fragments of a value JSON writes, unboxed, at `indentation`. */
function* valueFragmentsOf(
  value: unknown,
  indentation: string,
  writing: JsonWriting,
): Generator<string> {
  switch (typeof value) {
    case "string":
      yield* stringFragmentsOf(value);
      return;
    case "number":
      yield Number.isFinite(value) ? String(value) : "null";
      return;
    case "boolean":
      yield String(value);
      return;
    case "bigint":
      throw new TypeError("Do not know how to serialize a BigInt");
    default:
      if (value === null) {
        yield "null";
        return;
      }
      yield* containerFragmentsOf(value as object, indentation, writing);
  }
}

/** The fragments of `text` as a JSON string, its quotes around it. */
function* stringFragmentsOf(text: string): Generator<string> {
  if (text.length <= STRING_CUT_LENGTH) {
    yield JSON.stringify(text);
    return;
  }
  yield '"';
  // Cut never between a surrogate pair's halves, which would each be escaped alone.
  for (const cut of piecesOf(text, STRING_CUT_LENGTH)) {
    yield JSON.stringify(cut).slice(1, -1);
  }
  yield '"';
}

/**
 * The fragments of an array or an object at `indentation`. Throws a `TypeError` for one that holds
 * itself, as `JSON.stringify` does.
 */
function* containerFragmentsOf(
  container: object,
  indentation: string,
  writing: JsonWriting,
): Generator<string> {
  if (writing.ancestors.has(container)) {
    throw new TypeError("Converting circular structure to JSON");
  }
  writing.ancestors.add(container);
  const isArray = Array.isArray(container);
  const inner = indentation + writing.gap;
  const keys = isArray ? undefined : Object.keys(container);
  const length = isArray ? (container as readonly unknown[]).length : (keys?.length ?? 0);
  let isOpen = false;
  for (let index = 0; index < length; index += 1) {
    const key = keys?.[index] ?? String(index);
    const member = writtenValueOf(container, key);
    if (!isArray && !isWritten(member)) {
      continue;
    }
    yield `${isOpen ? "," : isArray ? "[" : "{"}${writing.gap === "" ? "" : `\n${inner}`}`;
    isOpen = true;
    if (!isArray) {
      yield* stringFragmentsOf(key);
      yield writing.gap === "" ? ":" : ": ";
    }
    if (isWritten(member)) {
      yield* valueFragmentsOf(member, inner, writing);
    } else {
      yield "null";
    }
  }
  const close = isArray ? "]" : "}";
  yield isOpen
    ? `${writing.gap === "" ? "" : `\n${indentation}`}${close}`
    : `${isArray ? "[" : "{"}${close}`;
  writing.ancestors.delete(container);
}
