// A packed text reads back exactly the string it holds, wherever a read falls against its chunks:
// multibyte characters sit across every chunk edge, a surrogate pair arrives split between two
// appends, and a cut lands between a pair's halves. With no codec, and with a codec whose module
// will not start, the text stays plain and still reads back exactly, the failure recorded.

import { describe, expect, it } from "vitest";

import { collectSentDiagnostics } from "#test/helpers/sent-diagnostics.js";
import { TEXT_CHUNK_MAX_BYTES, TextCompression } from "./compression.js";
import { PackedText } from "./packed.js";
import { measureUtf8ByteLength } from "./utf8-byte-length.js";

/** A window whose idle moments come at once, with time to spare. */
const IDLE_AT_ONCE = {
  requestIdleCallback: (task: IdleRequestCallback): number => {
    task({ didTimeout: false, timeRemaining: () => 50 });
    return 0;
  },
} as unknown as Window;

/** Lines of two-, three- and four-byte characters among ASCII, past several chunk edges. */
const SOURCE = Array.from(
  { length: 2_400 },
  (_, line) => `${String(line)}. Café — 漢字とかな 🙂 ok\n`,
).join("");

/**
 * A module that compiles and will not start: it imports a function `new WebAssembly.Instance`
 * is never handed.
 */
const UNSTARTABLE_MODULE_BYTES = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x04, 0x01, 0x60, 0x00, 0x00, 0x02, 0x09,
  0x01, 0x03, 0x65, 0x6e, 0x76, 0x01, 0x66, 0x00, 0x00,
]);

/** `source` appended to a fresh text in pieces of `pieceLength` units, pairs split between some. */
function appendedInPieces(
  source: string,
  pieceLength: number,
  compression: TextCompression,
): PackedText {
  const text = new PackedText(compression);
  for (let start = 0; start < source.length; start += pieceLength) {
    text.append(source.slice(start, start + pieceLength));
  }
  return text;
}

/** Every read a reader makes of `text` answers as `source` does. */
function expectReadsOf(text: PackedText, source: string): void {
  expect(text.length).toBe(source.length);
  expect(text.byteLength).toBe(measureUtf8ByteLength(source));
  expect(text.slice(0)).toBe(source);
  expect([...text.chunks()].join("")).toBe(source);
  for (let start = 0; start <= source.length; start += 1) {
    const end = start + 3;
    if (text.slice(start, end) !== source.slice(start, end)) {
      expect(text.slice(start, end), `slice at ${String(start)}`).toBe(source.slice(start, end));
    }
  }
  for (let start = 0; start < source.length; start += 997) {
    expect(text.slice(start, start + 40_000)).toBe(source.slice(start, start + 40_000));
  }
  for (const character of ["\uD83D", "—", "\n", "漢", "#"]) {
    for (let from = 0; from <= source.length; from += 1_013) {
      expect(text.indexOf(character, from)).toBe(source.indexOf(character, from));
    }
  }
}

describe("a packed text", () => {
  it("reads every range exactly, across chunk edges, a pair split between appends, and cuts", () => {
    const compression = new TextCompression(IDLE_AT_ONCE);
    expect(measureUtf8ByteLength(SOURCE)).toBeGreaterThan(TEXT_CHUNK_MAX_BYTES * 4);

    expectReadsOf(PackedText.of(SOURCE, compression), SOURCE);
    // 333 units splits a pair between two appends wherever an emoji straddles a piece's end.
    const grown = appendedInPieces(SOURCE, 333, compression);
    expectReadsOf(grown, SOURCE);

    // A cut between a pair's halves keeps the first half waiting, then takes its other half.
    const pairAt = SOURCE.indexOf("🙂", TEXT_CHUNK_MAX_BYTES * 2);
    for (const cut of [pairAt + 1, pairAt, TEXT_CHUNK_MAX_BYTES * 3, 1, 0]) {
      const revision = grown.revision;
      grown.truncate(cut);
      expect(grown.keepsPrefix(revision, cut)).toBe(false);
      expect(grown.keepsPrefix(grown.revision, cut)).toBe(true);
      expect(grown.slice(0)).toBe(SOURCE.slice(0, cut));
      expect(grown.byteLength).toBe(measureUtf8ByteLength(SOURCE.slice(0, cut)));
      grown.append(SOURCE.slice(cut));
      expect(grown.slice(0)).toBe(SOURCE);
    }
    expectReadsOf(grown, SOURCE);
  });

  it("notes where its first escape is, and forgets one a cut removes", () => {
    const text = new PackedText(new TextCompression(IDLE_AT_ONCE));
    text.append("plain ");
    expect(text.holdsEscape).toBe(false);
    text.append("\u001b[31mred");
    expect(text.firstEscapeIndex).toBe(6);
    text.truncate(6);
    expect(text.holdsEscape).toBe(false);
  });

  it("stays plain and reads back exactly with no codec, or a codec that will not start", async () => {
    const waiting = new TextCompression(IDLE_AT_ONCE);
    expectReadsOf(PackedText.of(SOURCE, waiting), SOURCE);
    expect(waiting.state).toBe("waiting");

    const sent = await collectSentDiagnostics();
    const failing = new TextCompression(IDLE_AT_ONCE);
    failing.provide(new WebAssembly.Module(UNSTARTABLE_MODULE_BYTES));
    const text = PackedText.of(SOURCE, failing);
    expect(failing.state).toBe("failed");
    expectReadsOf(text, SOURCE);
    expect(await sent.records()).toContainEqual(
      expect.objectContaining({ severity: "error", kind: "text-codec-failed" }),
    );
    sent.stop();
  });
});
