// A value read from JSON written back as JSON a little at a time, so no task on the page's thread
// grows with it. The text is the one `JSON.stringify(value, null, indent)` writes; a long string is
// escaped a cut at a time, each cut by `JSON.stringify` itself, its quotes left off.

import {
  joinIntoPiecesInSlices,
  piecesOf,
  TEXT_PIECE_LENGTH,
  type PiecedText,
} from "./text-pieces.js";

/**
 * `value`, a value read from JSON (strings, numbers, booleans, `null`, and arrays and objects of
 * them), as the JSON text `JSON.stringify(value, null, indent)` writes, in pieces: at once when it
 * is written inside one slice, else written in slices in `view`. `indent` counts spaces, 0 to 10.
 */
export function writeJsonInPieces(
  value: unknown,
  indent: number,
  view: Window,
): PiecedText | Promise<PiecedText> {
  return joinIntoPiecesInSlices(valueFragmentsOf(value, "", " ".repeat(indent)), view);
}

/**
 * The longest cut of a string escaped as one fragment: its escaped form is at most six code units
 * a unit (`\u001f`), so it stays within one piece.
 */
const STRING_CUT_LENGTH = Math.floor(TEXT_PIECE_LENGTH / 6);

/** The fragments of a value read from JSON at `indentation`, each level indented by `gap`. */
function* valueFragmentsOf(value: unknown, indentation: string, gap: string): Generator<string> {
  if (typeof value === "string") {
    yield* stringFragmentsOf(value);
  } else if (typeof value === "object" && value !== null) {
    yield* containerFragmentsOf(value, indentation, gap);
  } else {
    // A number, a boolean or `null`, which JSON writes as JavaScript prints it.
    yield String(value);
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

/** The fragments of an array or an object at `indentation`. */
function* containerFragmentsOf(
  container: object,
  indentation: string,
  gap: string,
): Generator<string> {
  const isArray = Array.isArray(container);
  // An array is read by index, so no list of its members is made at once.
  const keys = isArray ? undefined : Object.keys(container);
  const length = keys?.length ?? (container as readonly unknown[]).length;
  const [open, close] = isArray ? ["[", "]"] : ["{", "}"];
  if (length === 0) {
    yield `${open}${close}`;
    return;
  }
  const inner = indentation + gap;
  const lineBreak = gap === "" ? "" : `\n${inner}`;
  for (let index = 0; index < length; index += 1) {
    yield `${index === 0 ? open : ","}${lineBreak}`;
    const key = keys?.[index];
    if (key !== undefined) {
      yield* stringFragmentsOf(key);
      yield gap === "" ? ":" : ": ";
    }
    yield* valueFragmentsOf(
      key === undefined
        ? (container as readonly unknown[])[index]
        : (container as Readonly<Record<string, unknown>>)[key],
      inner,
      gap,
    );
  }
  yield `${gap === "" ? "" : `\n${indentation}`}${close}`;
}
