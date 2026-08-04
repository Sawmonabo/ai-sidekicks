// Plan-006 T3.3 — RFC 9162 §2.1.1 Merkle Tree Hash conformance.
//
// SCOPE. This file covers exactly one exported pure function,
// `computeMerkleRoot`, and nothing else about `MerkleAnchorService`. The
// cadence rule, the force-fire path, the durable queue and the upload drain are
// Plan-006 T3.5's file set
// (`Plan-006 §T3.5 — Phase 3 contract-test suite + end-to-end shred-safety regression (Plan-006 §Test And Verification Plan acceptance gate)`),
// and none of them is touched here.
//
// WHY THIS FILE EXISTS AT ALL. The root is an INTEROP CONTRACT, not an
// implementation detail: Phase 4's verifier and any external audit reader must
// recompute the same 32 bytes from stored `row_hash` values years later
// (`Security architecture §Verification Rules` rule 3, the anchor check —
// NOT step 3 of §Merkle Anchors, which is the upload step). A silent change to the
// split point or to either domain-separation prefix would break every previously
// signed anchor, and nothing would fail until an audit.
//
// WHAT CONFORMANCE MEANS HERE. `HASH` is BLAKE3 and the data entries `d[i]` are
// the range's 32-byte `session_events.row_hash` values; everything else is the
// RFC verbatim:
//
//   MTH({d[0]}) = HASH(0x00 || d[0])
//   MTH(D_n)    = HASH(0x01 || MTH(D[0:k]) || MTH(D[k:n])),  k = largest power
//                                                            of two < n
//
// HOW THE EXPECTATIONS ARE DERIVED. Each expected root is built by writing the
// recursion out by hand, level by level, rather than by recording whatever the
// implementation currently returns. A recorded golden value would re-pass after
// a split-point or prefix regression was baked into it; a hand-built one cannot.
// BLAKE3 itself is not under test (Phase 2's `signer.golden.test.ts` pins it
// against published vectors); what is under test is WHICH bytes reach it.
//
// Refs: RFC 9162 §2.1.1, Plan-006 T3.3, `Spec-006 §Post-Compaction Integrity`,
// `Security architecture §Merkle Anchors (Control-Plane Witness)`,
// `docs/architecture/schemas/local-sqlite-schema.md` (the canonical DDL comment
// on `pending_anchor_uploads.merkle_root`).

import { blake3 } from "@noble/hashes/blake3.js";
import { describe, expect, it } from "vitest";

import { computeMerkleRoot } from "../merkle-anchor-service.js";

// ----------------------------------------------------------------------------
// Helpers — the RFC's two hash calculations, spelled out
// ----------------------------------------------------------------------------

const NODE_LENGTH = 32;

/** A distinguishable 32-byte stand-in for a `session_events.row_hash`. */
function entry(marker: number): Uint8Array {
  return new Uint8Array(NODE_LENGTH).fill(marker);
}

function concat(...parts: ReadonlyArray<Uint8Array>): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const buffer = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    buffer.set(part, offset);
    offset += part.length;
  }
  return buffer;
}

/** `MTH({d}) = HASH(0x00 || d)`. */
function leafHash(data: Uint8Array): Uint8Array {
  return blake3(concat(Uint8Array.of(0x00), data));
}

/** `HASH(0x01 || left || right)`. */
function interiorHash(left: Uint8Array, right: Uint8Array): Uint8Array {
  return blake3(concat(Uint8Array.of(0x01), left, right));
}

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

// ----------------------------------------------------------------------------
// Structure — the split rule, level by level
// ----------------------------------------------------------------------------

describe("computeMerkleRoot — RFC 9162 §2.1.1 tree shape", () => {
  it("hashes a single-entry range as HASH(0x00 || d0)", () => {
    const d0 = entry(0xa1);
    expect(hex(computeMerkleRoot([d0]))).toBe(hex(leafHash(d0)));
  });

  it("does NOT return the bare row_hash for a single-entry range", () => {
    // The regression guard against the pre-2026-08-04 construction, which used
    // raw `row_hash` values as leaves and returned the leaf unchanged for n=1.
    // Both properties changed together; this arm pins the visible half.
    const d0 = entry(0xa1);
    expect(hex(computeMerkleRoot([d0]))).not.toBe(hex(d0));
  });

  it("hashes a two-entry range as HASH(0x01 || L0 || L1)", () => {
    // n=2 → k=1, so both children are leaf hashes.
    const [d0, d1] = [entry(0x01), entry(0x02)];
    const expected = interiorHash(leafHash(d0), leafHash(d1));
    expect(hex(computeMerkleRoot([d0, d1]))).toBe(hex(expected));
  });

  it("splits a three-entry range at k=2, leaving the remainder a bare leaf", () => {
    // The load-bearing shape difference from odd-leaf duplication: the odd
    // remainder passes through as MTH(D[2:3]) = L2 — it is neither duplicated nor
    // paired with anything.
    const [d0, d1, d2] = [entry(0x01), entry(0x02), entry(0x03)];
    const expected = interiorHash(interiorHash(leafHash(d0), leafHash(d1)), leafHash(d2));
    expect(hex(computeMerkleRoot([d0, d1, d2]))).toBe(hex(expected));
  });

  it("rejects the wrong split point for n=3 (k=1 instead of k=2)", () => {
    // A plausible off-by-one — `k` is the largest power of two SMALLER than n,
    // not the largest power of two at most n/2. With k=1 the tree leans the other
    // way and every anchor over an odd range changes.
    const [d0, d1, d2] = [entry(0x01), entry(0x02), entry(0x03)];
    const wrongSplit = interiorHash(leafHash(d0), interiorHash(leafHash(d1), leafHash(d2)));
    expect(hex(computeMerkleRoot([d0, d1, d2]))).not.toBe(hex(wrongSplit));
  });

  it("hashes a four-entry range as a balanced two-level tree (k=2)", () => {
    const [d0, d1, d2, d3] = [entry(0x01), entry(0x02), entry(0x03), entry(0x04)];
    const expected = interiorHash(
      interiorHash(leafHash(d0), leafHash(d1)),
      interiorHash(leafHash(d2), leafHash(d3)),
    );
    expect(hex(computeMerkleRoot([d0, d1, d2, d3]))).toBe(hex(expected));
  });

  it("splits a five-entry range at k=4 — a deliberately unbalanced tree", () => {
    // The RFC's non-power-of-two case: "The resulting Merkle Tree may thus not be
    // balanced; however, its shape is uniquely determined by the number of
    // leaves." A balanced-by-padding implementation fails here.
    const [d0, d1, d2, d3, d4] = [entry(0x01), entry(0x02), entry(0x03), entry(0x04), entry(0x05)];
    const left = interiorHash(
      interiorHash(leafHash(d0), leafHash(d1)),
      interiorHash(leafHash(d2), leafHash(d3)),
    );
    const expected = interiorHash(left, leafHash(d4));
    expect(hex(computeMerkleRoot([d0, d1, d2, d3, d4]))).toBe(hex(expected));
  });

  it("hashes an eight-entry range as a fully balanced three-level tree (k=4)", () => {
    const [d0, d1, d2, d3, d4, d5, d6, d7] = [
      entry(0x01),
      entry(0x02),
      entry(0x03),
      entry(0x04),
      entry(0x05),
      entry(0x06),
      entry(0x07),
      entry(0x08),
    ];
    const expected = interiorHash(
      interiorHash(
        interiorHash(leafHash(d0), leafHash(d1)),
        interiorHash(leafHash(d2), leafHash(d3)),
      ),
      interiorHash(
        interiorHash(leafHash(d4), leafHash(d5)),
        interiorHash(leafHash(d6), leafHash(d7)),
      ),
    );
    expect(hex(computeMerkleRoot([d0, d1, d2, d3, d4, d5, d6, d7]))).toBe(hex(expected));
  });

  it("always produces exactly 32 bytes", () => {
    for (let count = 1; count <= 17; count += 1) {
      const entries = Array.from({ length: count }, (_unused, index) => entry(index + 1));
      expect(computeMerkleRoot(entries).length).toBe(NODE_LENGTH);
    }
  });
});

// ----------------------------------------------------------------------------
// Domain separation — RFC 9162 §2.1.1's second-preimage defence
// ----------------------------------------------------------------------------

describe("computeMerkleRoot — 0x00/0x01 domain separation", () => {
  it("computes a leaf hash that is NOT the undomained hash of the same bytes", () => {
    // If the 0x00 prefix were dropped, `MTH({d})` would collapse to `HASH(d)`.
    const d0 = entry(0x42);
    expect(hex(computeMerkleRoot([d0]))).not.toBe(hex(blake3(d0)));
  });

  it("computes an interior node that is NOT the undomained hash of its children", () => {
    // If the 0x01 prefix were dropped, a two-entry root would collapse to
    // `HASH(L0 || L1)`.
    const [d0, d1] = [entry(0x01), entry(0x02)];
    const undomained = blake3(concat(leafHash(d0), leafHash(d1)));
    expect(hex(computeMerkleRoot([d0, d1]))).not.toBe(hex(undomained));
  });

  it("distinguishes a leaf from an interior node over identical bytes", () => {
    // The property the RFC calls out by name: "the hash calculations for leaves
    // and nodes differ; this domain separation is required to give second
    // preimage resistance." Without distinct prefixes these two would be equal,
    // and an attacker holding a row_hash equal to some interior node could
    // present a different entry list with the same root.
    const someBytes = entry(0x5a);
    const asLeaf = blake3(concat(Uint8Array.of(0x00), someBytes));
    const asInterior = blake3(concat(Uint8Array.of(0x01), someBytes));
    expect(hex(asLeaf)).not.toBe(hex(asInterior));
    expect(hex(computeMerkleRoot([someBytes]))).toBe(hex(asLeaf));
  });
});

// ----------------------------------------------------------------------------
// Root uniqueness — the CVE-2012-2459 collapse is GONE
// ----------------------------------------------------------------------------

describe("computeMerkleRoot — root uniqueness", () => {
  it("gives DIFFERENT roots for [A,B,C] and [A,B,C,C]", () => {
    // Under the superseded odd-leaf-duplication construction these two entry
    // lists collapsed to one root (CVE-2012-2459), so the root alone did not
    // determine the entry list and the safety rested on the anchor's signed
    // sequence range. RFC 9162's split construction removes the ambiguity at the
    // tree: "its shape is uniquely determined by the number of leaves." T4.1's
    // verifier therefore inherits no forward obligation from this file.
    const [a, b, c] = [entry(0x01), entry(0x02), entry(0x03)];
    expect(hex(computeMerkleRoot([a, b, c]))).not.toBe(hex(computeMerkleRoot([a, b, c, c])));
  });

  it("gives a distinct root for every entry count over the same prefix", () => {
    // The general form of the arm above: growing the range always changes the
    // root, so no two tree sizes over a shared prefix can be confused.
    const roots = new Set<string>();
    for (let count = 1; count <= 12; count += 1) {
      const entries = Array.from({ length: count }, (_unused, index) => entry(index + 1));
      roots.add(hex(computeMerkleRoot(entries)));
    }
    expect(roots.size).toBe(12);
  });

  it("commits to entry ORDER, not just to the entry set", () => {
    // The anchor witnesses an ordered range of the event log. A root invariant
    // under reordering would let a reordered log verify against its own anchor,
    // which is the precise tamper the witness exists to detect.
    const entries = [entry(0x01), entry(0x02), entry(0x03), entry(0x04)];
    const reversed = [...entries].reverse();
    expect(hex(computeMerkleRoot(entries))).not.toBe(hex(computeMerkleRoot(reversed)));
  });
});

// ----------------------------------------------------------------------------
// Determinism and caller safety
// ----------------------------------------------------------------------------

describe("computeMerkleRoot — determinism", () => {
  it("is deterministic across calls", () => {
    const entries = [entry(0x07), entry(0x08), entry(0x09)];
    expect(hex(computeMerkleRoot(entries))).toBe(hex(computeMerkleRoot(entries)));
  });

  it("does not mutate the caller's entries", () => {
    const entries = [entry(0x01), entry(0x02), entry(0x03)];
    const before = entries.map(hex);
    computeMerkleRoot(entries);
    expect(entries.map(hex)).toEqual(before);
  });

  it("does not alias any caller buffer into the returned root", () => {
    const entries = [entry(0x01)];
    const root = computeMerkleRoot(entries);
    entries[0]?.fill(0xff);
    expect(hex(root)).toBe(hex(leafHash(entry(0x01))));
  });
});

// ----------------------------------------------------------------------------
// Refusals
// ----------------------------------------------------------------------------

describe("computeMerkleRoot — refusals", () => {
  it("REFUSES an empty entry list instead of hashing the empty string", () => {
    // RFC 9162 defines `MTH({}) = HASH()` because a transparency log legitimately
    // starts empty. An anchor does not: `anchorRange` takes an inclusive
    // `[fromSeq, toSeq]` whose emptiness the schema CHECK already refuses, so zero
    // entries means rows the range covers are MISSING. Returning `HASH()` would
    // mint a valid signature over a commitment to nothing.
    expect(() => computeMerkleRoot([])).toThrow(/at least one leaf/);
  });

  it("refuses an entry that is not 32 bytes, naming its index", () => {
    // A short or long entry means a corrupt stored `row_hash`, so the message has
    // to point at the row rather than read as a bad-argument complaint.
    const entries = [entry(0x01), new Uint8Array(31).fill(0x02), entry(0x03)];
    expect(() => computeMerkleRoot(entries)).toThrow(/leaf 1 is 31 bytes/);
    expect(() => computeMerkleRoot([new Uint8Array(33)])).toThrow(/leaf 0 is 33 bytes/);
  });
});
