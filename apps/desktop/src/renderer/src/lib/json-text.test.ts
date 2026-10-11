import { describe, expect, it } from "vitest";

import { TASKS_AT_ONCE } from "#test/helpers/tasks-at-once.js";
import { writeJsonInPieces } from "./json-text.js";
import { TEXT_PIECE_LENGTH } from "./text-pieces.js";

/** `value` written in pieces, each checked to fit one piece, and joined. */
async function jsonWrittenInPieces(value: unknown, indent: number): Promise<string> {
  const { text, pieces } = await writeJsonInPieces(value, indent, TASKS_AT_ONCE);
  expect(pieces.every((piece) => piece.length <= TEXT_PIECE_LENGTH)).toBe(true);
  expect(pieces.join("")).toBe(text);
  return text;
}

describe("a value written as JSON in pieces", () => {
  const values: Readonly<Record<string, unknown>> = {
    "nested containers": {
      items: [{ id: 1, tags: ["a", "b"], meta: { deep: [[[]], {}] } }, [], {}, [null]],
      empty: { array: [], object: {} },
    },
    numbers: [0, -0, 1.5, -2e-7, 1e21, 123456789012345680000, Number.MAX_VALUE, NaN, Infinity],
    "what JSON omits or nulls": {
      kept: true,
      omitted: undefined,
      fn: () => 1,
      symbol: Symbol("s"),
      inArray: [undefined, () => 1, Symbol("t"), false],
    },
    "an object whose every member is omitted": { a: undefined, b: () => 1 },
    "a key that needs escaping": { 'quote " and \n newline': "é ☃ 😀", "\u0000": "\u001f " },
    "toJSON and boxed values": {
      date: new Date(Date.UTC(2026, 9, 11, 5, 0, 0)),
      custom: { toJSON: (key: string) => `member ${key}` },
      boxed: [Object(1), Object("two"), Object(false)],
    },
    // Of two runs of pairs one unit apart, one has a pair across every cut, however long a cut.
    "long strings of surrogate pairs": [
      "😀".repeat(TEXT_PIECE_LENGTH),
      `x${"😀".repeat(TEXT_PIECE_LENGTH)}`,
    ],
    "a long string of characters escaped to six units": "\u0001".repeat(TEXT_PIECE_LENGTH + 7),
    "many small items": Array.from({ length: 5_000 }, (_, index) => ({
      index,
      line: `line ${String(index)} "quoted" \t tabbed`,
    })),
    "a top-level string": "plain",
    "top-level null": null,
  };

  it.each(Object.entries(values))("writes %s as JSON.stringify does", async (_, value) => {
    for (const indent of [0, 2, 10]) {
      expect(await jsonWrittenInPieces(value, indent)).toBe(JSON.stringify(value, null, indent));
    }
  });

  it("refuses a value that holds itself, and a bigint, as JSON.stringify does", () => {
    const cycle: { self?: unknown } = {};
    cycle.self = [cycle];
    expect(() => writeJsonInPieces(cycle, 2, TASKS_AT_ONCE)).toThrow(TypeError);
    expect(() => writeJsonInPieces({ count: 1n }, 2, TASKS_AT_ONCE)).toThrow(TypeError);
  });
});
