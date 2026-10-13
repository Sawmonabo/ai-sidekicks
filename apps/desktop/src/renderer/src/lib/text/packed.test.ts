// A packed text reads back exactly the string it holds, wherever a read falls against its chunks:
// multibyte characters sit across every chunk edge, a surrogate pair arrives split between two
// appends, and a cut lands between a pair's halves. With no codec, and with a codec whose module
// will not start, the text stays plain and still reads back exactly, the failure recorded once
// for good. A codec that traps in its module packs nothing more and never reads a chunk wrong.

import { describe, expect, it } from "vitest";

import { collectSentDiagnostics } from "#test/helpers/sent-diagnostics.js";
import { PACKED_CHUNK_MAX_BYTES, TextCompression } from "./compression.js";
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

/**
 * A module with the codec's exports whose `compress` and `decompress` trap: a memory, both buffers
 * at its start, and `unreachable` as each call's body.
 */
const TRAPPING_CODEC_BYTES = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x0a, 0x02, 0x60, 0x00, 0x01, 0x7f, 0x60,
  0x01, 0x7f, 0x01, 0x7f, 0x03, 0x05, 0x04, 0x00, 0x00, 0x01, 0x01, 0x05, 0x03, 0x01, 0x00, 0x01,
  0x07, 0x3b, 0x05, 0x06, 0x6d, 0x65, 0x6d, 0x6f, 0x72, 0x79, 0x02, 0x00, 0x09, 0x70, 0x6c, 0x61,
  0x69, 0x6e, 0x5f, 0x70, 0x74, 0x72, 0x00, 0x00, 0x0a, 0x70, 0x61, 0x63, 0x6b, 0x65, 0x64, 0x5f,
  0x70, 0x74, 0x72, 0x00, 0x01, 0x08, 0x63, 0x6f, 0x6d, 0x70, 0x72, 0x65, 0x73, 0x73, 0x00, 0x02,
  0x0a, 0x64, 0x65, 0x63, 0x6f, 0x6d, 0x70, 0x72, 0x65, 0x73, 0x73, 0x00, 0x03, 0x0a, 0x13, 0x04,
  0x04, 0x00, 0x41, 0x00, 0x0b, 0x04, 0x00, 0x41, 0x00, 0x0b, 0x03, 0x00, 0x00, 0x0b, 0x03, 0x00,
  0x00, 0x0b,
]);

/** How many codec failures `records` holds. */
function codecFailureCount(records: readonly { readonly kind?: string }[]): number {
  return records.filter((record) => record.kind === "text-codec-failed").length;
}

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
    expect(measureUtf8ByteLength(SOURCE)).toBeGreaterThan(PACKED_CHUNK_MAX_BYTES * 4);

    expectReadsOf(PackedText.of(SOURCE, compression), SOURCE);
    // A whole text's rest that surely fits a chunk is encoded at its own size: a short text, the
    // rest after full chunks, and a text ending on a high surrogate, which waits.
    const afterFullChunks = `${"x".repeat(PACKED_CHUNK_MAX_BYTES * 2)}${SOURCE.slice(0, 900)}`;
    for (const whole of ["", "a", "Café 🙂", afterFullChunks, `${afterFullChunks}\uD83D`]) {
      expectReadsOf(PackedText.of(whole, compression), whole);
    }
    // 333 units splits a pair between two appends wherever an emoji straddles a piece's end.
    const grown = appendedInPieces(SOURCE, 333, compression);
    expectReadsOf(grown, SOURCE);

    // A cut between a pair's halves keeps the first half waiting, then takes its other half.
    const pairAt = SOURCE.indexOf("🙂", PACKED_CHUNK_MAX_BYTES * 2);
    for (const cut of [pairAt + 1, pairAt, PACKED_CHUNK_MAX_BYTES * 3, 1, 0]) {
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
    // A module in hand is kept when a later worker compiled none.
    const failing = new TextCompression(IDLE_AT_ONCE);
    failing.provide(new WebAssembly.Module(UNSTARTABLE_MODULE_BYTES));
    failing.provide(undefined);
    expect(failing.state).toBe("provided");
    const text = PackedText.of(SOURCE, failing);
    expect(failing.state).toBe("failed");
    expectReadsOf(text, SOURCE);

    // A text admitted while no worker compiled a module waits for the one a later worker posts.
    const absent = new TextCompression(IDLE_AT_ONCE);
    absent.provide(undefined);
    const admitted = PackedText.of(SOURCE, absent);
    expect(absent.state).toBe("absent");
    absent.provide(new WebAssembly.Module(UNSTARTABLE_MODULE_BYTES));
    expect(absent.state).toBe("failed");
    expectReadsOf(admitted, SOURCE);

    // A failed codec stays failed, whatever a later worker posts, and is recorded once.
    failing.provide(new WebAssembly.Module(UNSTARTABLE_MODULE_BYTES));
    expect(failing.state).toBe("failed");
    const records = await sent.records();
    expect(records).toContainEqual(
      expect.objectContaining({ severity: "error", kind: "text-codec-failed" }),
    );
    expect(codecFailureCount(records)).toBe(2);
    sent.stop();
  });

  it("records a codec that traps once, keeps the chunk plain, and throws for one it cannot read", async () => {
    const sent = await collectSentDiagnostics();
    const trapping = new TextCompression(IDLE_AT_ONCE);
    trapping.provide(new WebAssembly.Module(TRAPPING_CODEC_BYTES));
    const chunk = new TextEncoder().encode("a chunk the module traps on");

    expect(trapping.pack(chunk)).toBeUndefined();
    expect(trapping.state).toBe("failed");
    expect(() => trapping.decode(chunk, chunk.byteLength, true)).toThrow("could not be unpacked");
    expect(codecFailureCount(await sent.records())).toBe(1);
    sent.stop();
  });
});
