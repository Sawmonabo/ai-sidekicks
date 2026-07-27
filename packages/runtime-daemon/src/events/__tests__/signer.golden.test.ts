// Golden-vector suite for the BLAKE3 hash-chain + Ed25519 row signer
// (Plan-006 T2.2).
//
// SCOPE NOTE — WHY THIS FILE EXISTS ALONGSIDE `canonicalizer.golden.test.ts`.
// T2.3 is a single task covering TWO suites, and they are split by SUBJECT
// rather than by task: the sibling pins the canonicalizer's byte-stability
// vectors, while this file pins `signer.ts` — the module that mints the two
// tamper-evidence commitments carried on every row. This suite is where T2.3's
// I-006-2-04 (genesis seed, and the `BLAKE3(prev_hash || canonical)` linkage
// that produces `prev_hash[n] = row_hash[n-1]`) and I-006-2-06 (one
// canonicalization per row) legs are discharged. Nothing else in Phase 2
// reaches this module: T2.5 is the post-shred property suite and is scoped to
// T2.4's PII codec. Several behaviours below encode a specific defect closed in
// review — see the ZIP-215 vector.
//
// WHAT THE HEX FIXTURES ARE, AND ARE NOT. Two different kinds of constant live
// here and they carry different authority:
//
//   • RFC 8032 §7.1 keypairs (TEST 1 for the daemon, TEST 2 for the
//     participant) — EXTERNALLY published. `DAEMON_PUBLIC_KEY` is asserted to
//     equal the RFC's published public key, so the key-derivation leg is
//     genuinely conformance-checked rather than self-consistent.
//   • Row digests and signatures — implementation-pinned REGRESSION constants.
//     No RFC publishes what an AI-Sidekicks row must hash to. Each is therefore
//     ALSO asserted against a computation written independently inside this
//     file (an explicit `prev_hash || canonical` concatenation fed to BLAKE3,
//     and a direct `ed25519.sign` over the canonical bytes) so the pins cannot
//     silently enshrine a formula change: the hex catches drift, the
//     independent computation catches a wrong formula.
//
// Refs: `Spec-006 §Integrity Protocol`, `Spec-006 §Canonical Serialization Rules`,
// `Plan-006 §Hash Chain`, `Plan-006 §Ed25519 Signatures`,
// `Security Architecture §Verification Rules`.
import { ed25519 } from "@noble/curves/ed25519.js";
import { equalBytes } from "@noble/curves/utils.js";
import { blake3 } from "@noble/hashes/blake3.js";
import { describe, expect, it } from "vitest";
import { canonicalizeJson } from "../canonicalizer.js";
import type { CanonicalBytes } from "../canonicalizer.js";
import {
  GENESIS_PREV_HASH,
  mintParticipantSignature,
  signRow,
  verifyParticipantSignature,
  verifyRow,
} from "../signer.js";
import type { Ed25519PrivateKey, Ed25519PublicKey, SignedRow } from "../signer.js";

// --------------------------------------------------------------------------
// Helpers.
// --------------------------------------------------------------------------

function hexToBytes(groupedHex: string): Uint8Array {
  const compactHex = groupedHex.replace(/\s+/g, "");
  const bytes = new Uint8Array(compactHex.length / 2);
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = Number.parseInt(compactHex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * `prev_hash || canonical_bytes(row)` — the BLAKE3 preimage
 * `Plan-006 §Hash Chain` specifies, written out HERE rather than imported.
 * `signer.ts`'s own `buildChainInput` is module-private, and re-using it would
 * make the digest assertions circular: this suite must be able to fail if the
 * concatenation order is ever reversed.
 */
function concatenateChainInput(prevHash: Uint8Array, canonical: Uint8Array): Uint8Array {
  const chainInput = new Uint8Array(prevHash.length + canonical.length);
  chainInput.set(prevHash, 0);
  chainInput.set(canonical, prevHash.length);
  return chainInput;
}

/** Copies `source` and flips the low bit of byte 0 — a MINIMAL corruption. */
function withFlippedFirstBit(source: Uint8Array): Uint8Array {
  const corrupted = Uint8Array.from(source);
  corrupted[0] = (corrupted[0] ?? 0) ^ 0x01;
  return corrupted;
}

function captureThrownMessage(thunk: () => unknown): string {
  try {
    thunk();
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected the call to throw, but it returned normally");
}

// --------------------------------------------------------------------------
// Key material — RFC 8032 §7.1 test vectors.
// --------------------------------------------------------------------------
//
// The brand casts below are the ONE thing this suite does that production code
// may not: `Ed25519PrivateKey` / `Ed25519PublicKey` export no constructor
// precisely so key material enters the type system at exactly one greppable
// site (T2.7's `signing-key-source.ts`). A test standing in for that custody
// module has to narrow the same way T2.7 does. `CanonicalBytes`, by contrast, is
// NEVER cast here — it is obtained only from `canonicalizeJson`, the way every
// production caller must.

const RFC_8032_TEST_1_SEED_HEX = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
const RFC_8032_TEST_1_PUBLIC_KEY_HEX =
  "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";
const RFC_8032_TEST_2_SEED_HEX = "4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb";
const RFC_8032_TEST_2_PUBLIC_KEY_HEX =
  "3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c";

const DAEMON_SIGNING_KEY: Ed25519PrivateKey = hexToBytes(
  RFC_8032_TEST_1_SEED_HEX,
) as Ed25519PrivateKey;
const DAEMON_PUBLIC_KEY: Ed25519PublicKey = ed25519.getPublicKey(
  DAEMON_SIGNING_KEY,
) as Ed25519PublicKey;

const PARTICIPANT_SIGNING_KEY: Ed25519PrivateKey = hexToBytes(
  RFC_8032_TEST_2_SEED_HEX,
) as Ed25519PrivateKey;
const PARTICIPANT_PUBLIC_KEY: Ed25519PublicKey = ed25519.getPublicKey(
  PARTICIPANT_SIGNING_KEY,
) as Ed25519PublicKey;

// --------------------------------------------------------------------------
// Row material.
// --------------------------------------------------------------------------

const CANONICAL_ROW: CanonicalBytes = canonicalizeJson({
  category: "audit_integrity",
  sequence: 7,
  type: "audit.chain_verified",
});

const CANONICAL_ROW_TEXT =
  '{"category":"audit_integrity","sequence":7,"type":"audit.chain_verified"}';

const PREV_HASH_HEX = "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20";

const EXPECTED_ROW_HASH_HEX = "2c677d7f44d73de10f9e2509f6a26baa1c41ce043541b38c34e15bb5bf6381e5";
const EXPECTED_GENESIS_ROW_HASH_HEX =
  "9025fc2182b8dd63f0a22d7beeed994890dc8be7f77c873c0ac881bb8d15dbd8";
const EXPECTED_DAEMON_SIGNATURE_HEX =
  "fdf7891150a2ae0268141c22a32bff2464ea578a7ab3e437e16d9ce995b2b98b" +
  "b8c7464c96e84672b10684d75fbb4dc2eba8acfd2e04b35eaedd33f9b16e5c02";
const EXPECTED_PARTICIPANT_SIGNATURE_HEX =
  "889f46a0ebd2d0790d831e102e14fc5c743d0cdbce6aa3580d34ecb8cf0b97b6" +
  "45455308532c3d6e2a7e388f3efb2383ed516132f689f70e7bbead3d1f657d0a";

/** Mints the reference row fresh per test, so no test can observe another's mutation. */
function signReferenceRow(): SignedRow {
  return signRow(CANONICAL_ROW, hexToBytes(PREV_HASH_HEX), DAEMON_SIGNING_KEY);
}

// --------------------------------------------------------------------------
// signRow — determinism and the golden digests.
// --------------------------------------------------------------------------

describe("signRow — deterministic commitments over one canonicalization", () => {
  it("derives the RFC 8032 §7.1 public keys from the published secret keys", () => {
    // Anchors the key material to an external publication, so the row
    // signatures below are traceable rather than arbitrary.
    expect(bytesToHex(DAEMON_PUBLIC_KEY)).toBe(RFC_8032_TEST_1_PUBLIC_KEY_HEX);
    expect(bytesToHex(PARTICIPANT_PUBLIC_KEY)).toBe(RFC_8032_TEST_2_PUBLIC_KEY_HEX);
  });

  it("canonicalizes the reference row to the expected bytes", () => {
    // Pinned because every digest below is a function of these bytes: if the
    // canonical form moved, the digest failures would otherwise be unreadable.
    expect(new TextDecoder().decode(CANONICAL_ROW)).toBe(CANONICAL_ROW_TEXT);
  });

  it("produces the golden row_hash and daemon_signature", () => {
    const signed = signReferenceRow();
    expect(bytesToHex(signed.rowHash)).toBe(EXPECTED_ROW_HASH_HEX);
    expect(bytesToHex(signed.daemonSignature)).toBe(EXPECTED_DAEMON_SIGNATURE_HEX);
    expect(bytesToHex(signed.prevHash)).toBe(PREV_HASH_HEX);
  });

  it("computes row_hash as BLAKE3(prev_hash || canonical_bytes), in that order", () => {
    // The independent-formula half of the pin. A refactor that reversed the
    // concatenation, or hashed the canonical bytes alone, would still be
    // self-consistent and would still be deterministic — only this assertion
    // catches it.
    const signed = signReferenceRow();
    const independentDigest = blake3(
      concatenateChainInput(hexToBytes(PREV_HASH_HEX), CANONICAL_ROW),
    );
    expect(bytesToHex(signed.rowHash)).toBe(bytesToHex(independentDigest));

    const reversedOrderDigest = blake3(
      concatenateChainInput(CANONICAL_ROW, hexToBytes(PREV_HASH_HEX)),
    );
    expect(bytesToHex(signed.rowHash)).not.toBe(bytesToHex(reversedOrderDigest));
  });

  it("signs the CANONICAL BYTES themselves, not the row_hash (I-006-2-06)", () => {
    // `signRow` accepts `CanonicalBytes` once and hands the identical array to
    // BLAKE3 and to `ed25519.sign`. Comparing against a direct signature over
    // those same bytes is what proves the Ed25519 message is the canonical
    // bytes — a refactor that signed the digest instead would still verify
    // against itself but would break every independent verifier.
    const signed = signReferenceRow();
    expect(bytesToHex(signed.daemonSignature)).toBe(
      bytesToHex(ed25519.sign(CANONICAL_ROW, DAEMON_SIGNING_KEY)),
    );
    expect(bytesToHex(signed.daemonSignature)).not.toBe(
      bytesToHex(ed25519.sign(signed.rowHash, DAEMON_SIGNING_KEY)),
    );
  });

  it("is byte-identical across repeated calls — RFC 8032 §5.1.6 determinism", () => {
    // Ed25519 derives its per-signature nonce from the secret key and the
    // message, never from an RNG. This is what makes `signRow` `idempotent`:
    // re-running it over one row reproduces the same three columns rather than
    // minting a second, differing signature.
    const first = signReferenceRow();
    const second = signReferenceRow();
    expect(bytesToHex(second.rowHash)).toBe(bytesToHex(first.rowHash));
    expect(bytesToHex(second.daemonSignature)).toBe(bytesToHex(first.daemonSignature));

    // Differing-input control — without it, a stubbed-out signer returning a
    // constant would satisfy the assertions above.
    const differentPrevHash = signRow(
      CANONICAL_ROW,
      withFlippedFirstBit(hexToBytes(PREV_HASH_HEX)),
      DAEMON_SIGNING_KEY,
    );
    expect(bytesToHex(differentPrevHash.rowHash)).not.toBe(bytesToHex(first.rowHash));

    const differentKey = signRow(CANONICAL_ROW, hexToBytes(PREV_HASH_HEX), PARTICIPANT_SIGNING_KEY);
    expect(bytesToHex(differentKey.daemonSignature)).not.toBe(bytesToHex(first.daemonSignature));
  });

  it("seeds the genesis row from 32 zero bytes (I-006-2-04)", () => {
    expect(GENESIS_PREV_HASH).toHaveLength(32);
    expect(bytesToHex(GENESIS_PREV_HASH)).toBe("00".repeat(32));
    const genesisRow = signRow(CANONICAL_ROW, GENESIS_PREV_HASH, DAEMON_SIGNING_KEY);
    expect(bytesToHex(genesisRow.rowHash)).toBe(EXPECTED_GENESIS_ROW_HASH_HEX);
  });

  it("refuses a prev_hash that is not 32 bytes, before minting a doomed signature", () => {
    // A wrong-width chain link hashes happily and mints a signature over a
    // preimage no verifier can reproduce: an untampered row that fails forever.
    // Refused at the boundary rather than at the SQLite CHECK constraint.
    expect(
      captureThrownMessage(() => signRow(CANONICAL_ROW, new Uint8Array(31), DAEMON_SIGNING_KEY)),
    ).toMatch(/requires a 32-byte Uint8Array prev_hash/);

    // Byte-NESS, not just width: a 32-CHARACTER string clears a bare length
    // check and then coerces to near-zero bytes through
    // `TypedArray.prototype.set`. The caller appending row n re-reads row n-1's
    // stored `row_hash` out of SQLite to use as this `prevHash`, and a `BLOB`
    // column can genuinely hand back a string.
    const thirtyTwoCharacterString = "0".repeat(32);
    expect(thirtyTwoCharacterString).toHaveLength(32);
    expect(
      captureThrownMessage(() =>
        signRow(
          CANONICAL_ROW,
          thirtyTwoCharacterString as unknown as Uint8Array,
          DAEMON_SIGNING_KEY,
        ),
      ),
    ).toMatch(/a non-Uint8Array value of type string/);
  });

  it("echoes a defensive COPY of prev_hash, not the caller's array", () => {
    // The caller keeps its array and may reuse or mutate it — and at
    // `sequence = 0` that array is `GENESIS_PREV_HASH`, a shared module-level
    // constant. Echoing by reference would leave a window between the return
    // and the INSERT in which a write into either desynchronizes the persisted
    // `prev_hash` from the bytes that fed the digest.
    const callerPrevHash = hexToBytes(PREV_HASH_HEX);
    const signed = signRow(CANONICAL_ROW, callerPrevHash, DAEMON_SIGNING_KEY);

    callerPrevHash.fill(0xff);

    expect(signed.prevHash).not.toBe(callerPrevHash);
    expect(bytesToHex(signed.prevHash)).toBe(PREV_HASH_HEX);

    // The property that actually matters: the echoed link still agrees with the
    // digest that was signed, so persisting the returned trio as a unit yields
    // a row that verifies. Aliasing would make this recomputation hash
    // 0xff…-bytes and disagree.
    expect(bytesToHex(blake3(concatenateChainInput(signed.prevHash, CANONICAL_ROW)))).toBe(
      bytesToHex(signed.rowHash),
    );
    expect(verifyRow(CANONICAL_ROW, signed, DAEMON_PUBLIC_KEY)).toStrictEqual({ valid: true });
  });

  it("does not alias GENESIS_PREV_HASH into the returned row", () => {
    const genesisRow = signRow(CANONICAL_ROW, GENESIS_PREV_HASH, DAEMON_SIGNING_KEY);
    expect(genesisRow.prevHash).not.toBe(GENESIS_PREV_HASH);
    expect(bytesToHex(GENESIS_PREV_HASH)).toBe("00".repeat(32));
  });
});

// --------------------------------------------------------------------------
// verifyRow — verdicts, and the observable check order.
// --------------------------------------------------------------------------

describe("verifyRow — rules 1 and 2 of `Security Architecture §Verification Rules`", () => {
  it("accepts an honestly-signed row", () => {
    expect(verifyRow(CANONICAL_ROW, signReferenceRow(), DAEMON_PUBLIC_KEY)).toStrictEqual({
      valid: true,
    });
  });

  it("reports signature_mismatch when only the signature is corrupted", () => {
    const tamperedSignature: SignedRow = {
      ...signReferenceRow(),
      daemonSignature: withFlippedFirstBit(signReferenceRow().daemonSignature),
    };
    expect(verifyRow(CANONICAL_ROW, tamperedSignature, DAEMON_PUBLIC_KEY)).toStrictEqual({
      valid: false,
      failureMode: "signature_mismatch",
    });
  });

  it("reports hash_mismatch when only the row_hash is corrupted", () => {
    const tamperedHash: SignedRow = {
      ...signReferenceRow(),
      rowHash: withFlippedFirstBit(signReferenceRow().rowHash),
    };
    expect(verifyRow(CANONICAL_ROW, tamperedHash, DAEMON_PUBLIC_KEY)).toStrictEqual({
      valid: false,
      failureMode: "hash_mismatch",
    });
  });

  it("reports hash_mismatch — not signature_mismatch — for a row failing BOTH checks", () => {
    // STAGE 3 BEFORE STAGE 4 — the spec-order leg of an order that is now FOUR
    // stages, not two: (1) structural chain-column guard → `hash_mismatch`,
    // (2) all three integrity columns zero-filled → `signature_placeholder`,
    // (3) hash recompute → `hash_mismatch`, (4) signature verify →
    // `signature_mismatch`. First failure wins throughout. Stages 1-2 are
    // pinned in the placeholder describe block below; this test owns 3-before-4
    // and is unaffected by the newer stages — this row's `prev_hash` is
    // non-zero, so stage 2 short-circuits on its very first conjunct.
    //
    // Both corruptions are single-BIT flips of otherwise-valid 32/64-byte
    // values, deliberately. Replacing `rowHash` wholesale could trip
    // `verifyRow`'s malformed-shape guard instead of the digest COMPARISON, and
    // this test would then pass without exercising check order at all. The two
    // single-fault tests above are the controls that make this one
    // discriminating: each corruption is known to produce its own failure mode
    // in isolation, so the verdict here is evidence of ORDER.
    const failsBothChecks: SignedRow = {
      ...signReferenceRow(),
      rowHash: withFlippedFirstBit(signReferenceRow().rowHash),
      daemonSignature: withFlippedFirstBit(signReferenceRow().daemonSignature),
    };
    expect(verifyRow(CANONICAL_ROW, failsBothChecks, DAEMON_PUBLIC_KEY)).toStrictEqual({
      valid: false,
      failureMode: "hash_mismatch",
    });
  });

  it("reports hash_mismatch when the canonical bytes do not match the row", () => {
    // The verifier re-canonicalizes the stored row; a tampered envelope field
    // changes those bytes and breaks the digest before the signature is reached.
    const otherCanonical = canonicalizeJson({
      category: "audit_integrity",
      sequence: 8,
      type: "audit.chain_verified",
    });
    expect(verifyRow(otherCanonical, signReferenceRow(), DAEMON_PUBLIC_KEY)).toStrictEqual({
      valid: false,
      failureMode: "hash_mismatch",
    });
  });
});

// --------------------------------------------------------------------------
// Plan-001's zero-fill placeholder — the fail-closed safety net (stage 2).
// --------------------------------------------------------------------------

const CHAIN_HASH_LENGTH = 32;
const ED25519_SIGNATURE_LENGTH = 64;

/**
 * The exact trio `session/session-service.ts` INSERTs today: 32-byte
 * `ZERO_HASH` for BOTH chain columns, 64-byte `ZERO_SIGNATURE` for the
 * signature.
 *
 * ALL THREE COLUMNS ARE LOAD-BEARING, not just the signature: stage 2 keys on
 * the whole trio, so this fixture is the predicate's positive case and every
 * `...buildPlaceholderRow()` spread below is deriving a NEAR-miss from it.
 *
 * Rebuilt here rather than imported. Those constants are module-private to the
 * Plan-001 service, and importing them would make this suite track whatever
 * that service does rather than pin the shape `verifyRow` must recognize — a
 * placeholder-shape change there should surface as a FAILURE here, not be
 * silently adopted.
 */
function buildPlaceholderRow(): SignedRow {
  return {
    prevHash: new Uint8Array(CHAIN_HASH_LENGTH),
    rowHash: new Uint8Array(CHAIN_HASH_LENGTH),
    daemonSignature: new Uint8Array(ED25519_SIGNATURE_LENGTH),
  };
}

describe("verifyRow — the zero-fill placeholder verdict", () => {
  it("reports signature_placeholder and NOT hash_mismatch for Plan-001's placeholder row", () => {
    // ======================== THE ORDERING ASSERTION ========================
    // THIS IS THE POINT OF THE TEST, AND THE `not.toStrictEqual` IS NOT
    // DECORATION.
    //
    // A placeholder row zero-fills ALL THREE integrity columns, so it fails the
    // hash recompute as well as carrying a placeholder signature. Move the
    // placeholder check below the hash compare and this row reports
    // `hash_mismatch`, the new verdict becomes unreachable, and the enum value
    // is dead code. The positive assertion alone cannot tell those two worlds
    // apart once someone "simplifies" the branch; the negative one fails
    // loudly.
    // ========================================================================
    const placeholderRow = buildPlaceholderRow();

    // Self-evidencing control: the placeholder row genuinely DOES fail the hash
    // check, so "not hash_mismatch" is a claim about check ORDER rather than
    // about this row happening to carry a valid digest. Recomputed from an
    // independent concatenation, the same way every digest pin above is.
    const recomputedRowHash = blake3(
      concatenateChainInput(new Uint8Array(CHAIN_HASH_LENGTH), CANONICAL_ROW),
    );
    expect(bytesToHex(recomputedRowHash)).not.toBe("00".repeat(CHAIN_HASH_LENGTH));

    expect(verifyRow(CANONICAL_ROW, placeholderRow, DAEMON_PUBLIC_KEY)).toStrictEqual({
      valid: false,
      failureMode: "signature_placeholder",
    });
    expect(verifyRow(CANONICAL_ROW, placeholderRow, DAEMON_PUBLIC_KEY)).not.toStrictEqual({
      valid: false,
      failureMode: "hash_mismatch",
    });

    // better-sqlite3 hands a BLOB back as a `Buffer`, which is what the real
    // read path produces. `Buffer extends Uint8Array` so `isBytesOfLength`
    // accepts it — asserted rather than assumed, since the whole verdict rests
    // on that `instanceof`.
    const bufferBackedPlaceholder: SignedRow = {
      prevHash: Buffer.alloc(CHAIN_HASH_LENGTH),
      rowHash: Buffer.alloc(CHAIN_HASH_LENGTH),
      daemonSignature: Buffer.alloc(ED25519_SIGNATURE_LENGTH),
    };
    expect(verifyRow(CANONICAL_ROW, bufferBackedPlaceholder, DAEMON_PUBLIC_KEY)).toStrictEqual({
      valid: false,
      failureMode: "signature_placeholder",
    });
  });

  it("does NOT fire on a zeroed signature ALONE — an honest chain is not a placeholder write", () => {
    // THE DISCRIMINATION THE THREE-COLUMN PREDICATE BUYS. This row's chain
    // columns are honest — a real `prev_hash` and its matching `row_hash` — so
    // it is NOT what `session-service.ts` produces: that path emits the zero
    // trio together and never a mix. It therefore carries past stage 2, clears
    // the hash recompute, and reports `signature_mismatch` at stage 4.
    //
    // A signature-ONLY stage 2 returns `signature_placeholder` here instead.
    // The test below is where that difference stops being cosmetic.
    const honestChainZeroSignature: SignedRow = {
      ...signReferenceRow(),
      daemonSignature: new Uint8Array(ED25519_SIGNATURE_LENGTH),
    };
    expect(verifyRow(CANONICAL_ROW, honestChainZeroSignature, DAEMON_PUBLIC_KEY)).toStrictEqual({
      valid: false,
      failureMode: "signature_mismatch",
    });
  });

  it("reports hash_mismatch for a TAMPERED row that also carries a zeroed signature", () => {
    // THE SEVERITY-DOWNGRADE VECTOR — THE REASON STAGE 2 KEYS ON ALL THREE
    // COLUMNS RATHER THAN THE SIGNATURE. This row's `row_hash` is forged. Under
    // a signature-only predicate it reports `signature_placeholder`, i.e. "an
    // engineering sequencing bug, not an attack", for a row that IS an attack —
    // routing a tamper AWAY from security on-call, which is the same
    // wrong-verdict failure the branch was added to prevent, pointed the other
    // way. Requiring all three carries the row past stage 2 on its surviving
    // non-zero hashes and lets stage 3 return the truthful verdict.
    const tamperedWithZeroSignature: SignedRow = {
      ...signReferenceRow(),
      rowHash: withFlippedFirstBit(signReferenceRow().rowHash),
      daemonSignature: new Uint8Array(ED25519_SIGNATURE_LENGTH),
    };
    expect(verifyRow(CANONICAL_ROW, tamperedWithZeroSignature, DAEMON_PUBLIC_KEY)).toStrictEqual({
      valid: false,
      failureMode: "hash_mismatch",
    });
    expect(
      verifyRow(CANONICAL_ROW, tamperedWithZeroSignature, DAEMON_PUBLIC_KEY),
    ).not.toStrictEqual({ valid: false, failureMode: "signature_placeholder" });
  });

  it("accepts a LEGITIMATE signed genesis row — a zero prev_hash is not a placeholder", () => {
    // NOT OBVIOUS, WHICH IS EXACTLY WHY IT IS PINNED. A zero `prev_hash` is
    // LEGITIMATE at `sequence = 0`: `0001-initial.ts` declares the column "32
    // bytes; zero-filled at sequence=0" and {@link GENESIS_PREV_HASH} encodes
    // that. So a REAL genesis row signed by T3.1 shares one of its three
    // columns with Plan-001's placeholder trio, and a predicate that kept the
    // `prev_hash` conjunct while dropping the `row_hash` one would misreport
    // EVERY genesis row in the database as `signature_placeholder` — a
    // fail-closed net that fails closed on honest data.
    const genesisRow = signRow(CANONICAL_ROW, GENESIS_PREV_HASH, DAEMON_SIGNING_KEY);

    // The shared column, asserted rather than assumed: this test is only
    // discriminating if the genesis row really does carry a zero `prev_hash`
    // alongside a non-zero `row_hash`.
    expect(bytesToHex(genesisRow.prevHash)).toBe("00".repeat(CHAIN_HASH_LENGTH));
    expect(bytesToHex(genesisRow.rowHash)).toBe(EXPECTED_GENESIS_ROW_HASH_HEX);

    expect(verifyRow(CANONICAL_ROW, genesisRow, DAEMON_PUBLIC_KEY)).toStrictEqual({ valid: true });
    expect(verifyRow(CANONICAL_ROW, genesisRow, DAEMON_PUBLIC_KEY)).not.toStrictEqual({
      valid: false,
      failureMode: "signature_placeholder",
    });
  });

  it("yields to STAGE 1 — a malformed chain column reports hash_mismatch even with a zero signature", () => {
    // The other order edge, and the one the placeholder test alone cannot pin:
    // without this, a THREE-stage order that LED with the placeholder check
    // would satisfy every other assertion in this file. A non-byte or
    // wrong-width chain column is a corruption / plumbing problem and keeps its
    // `hash_mismatch` verdict regardless of what the signature column holds.
    //
    // The two rows fail a stage-2-first ordering DIFFERENTLY, and both failures
    // are the point. The string `prev_hash` would reach `isAllZeroBytes` with
    // no `.every` to call and THROW; the short `row_hash` is all-zero, so the
    // whole trio matches and it would return `signature_placeholder`. Stage 1
    // is what makes stage 2's two chain conjuncts safe to write without their
    // own byte-ness guard.
    const stringPrevHashZeroSignature: SignedRow = {
      prevHash: "0".repeat(CHAIN_HASH_LENGTH) as unknown as Uint8Array,
      rowHash: new Uint8Array(CHAIN_HASH_LENGTH),
      daemonSignature: new Uint8Array(ED25519_SIGNATURE_LENGTH),
    };
    expect(verifyRow(CANONICAL_ROW, stringPrevHashZeroSignature, DAEMON_PUBLIC_KEY)).toStrictEqual({
      valid: false,
      failureMode: "hash_mismatch",
    });

    const shortRowHashZeroSignature: SignedRow = {
      prevHash: new Uint8Array(CHAIN_HASH_LENGTH),
      rowHash: new Uint8Array(CHAIN_HASH_LENGTH - 1),
      daemonSignature: new Uint8Array(ED25519_SIGNATURE_LENGTH),
    };
    expect(verifyRow(CANONICAL_ROW, shortRowHashZeroSignature, DAEMON_PUBLIC_KEY)).toStrictEqual({
      valid: false,
      failureMode: "hash_mismatch",
    });
  });

  it("is scoped to exactly 64 bytes — a wrong-width all-zero signature is never the placeholder", () => {
    // `0001-initial.ts` declares `CHECK(length(daemon_signature) = 64)`, so a
    // 63-byte value never came through the INSERT: it is corruption, not a
    // placeholder, and keeps the verdict every other wrong-shaped stored
    // signature gets.
    const shortZeroSignature: SignedRow = {
      ...signReferenceRow(),
      daemonSignature: new Uint8Array(ED25519_SIGNATURE_LENGTH - 1),
    };
    expect(verifyRow(CANONICAL_ROW, shortZeroSignature, DAEMON_PUBLIC_KEY)).toStrictEqual({
      valid: false,
      failureMode: "signature_mismatch",
    });

    // THE DISCRIMINATING CASE. The row above has an honest `prev_hash`, so it
    // short-circuits stage 2 on the FIRST conjunct and would pass even with the
    // width requirement deleted. Zero the chain columns too and only the
    // 64-byte scoping stands between this row and `signature_placeholder`.
    const shortZeroSignatureOnZeroChain: SignedRow = {
      ...buildPlaceholderRow(),
      daemonSignature: new Uint8Array(ED25519_SIGNATURE_LENGTH - 1),
    };
    expect(
      verifyRow(CANONICAL_ROW, shortZeroSignatureOnZeroChain, DAEMON_PUBLIC_KEY),
    ).toStrictEqual({ valid: false, failureMode: "hash_mismatch" });
  });

  it("does not fire on a NON-BYTE stored signature — the check stays total", () => {
    // Stage 1 validates only the two CHAIN columns, so `daemonSignature`
    // reaches stage 2 with its `Uint8Array` declaration unchecked across the
    // SQLite boundary. A 64-CHARACTER string is not bytes, is not the
    // placeholder, and must reach a verdict without throwing.
    const sixtyFourCharacterString = "0".repeat(ED25519_SIGNATURE_LENGTH);
    expect(sixtyFourCharacterString).toHaveLength(ED25519_SIGNATURE_LENGTH);

    const stringSignature: SignedRow = {
      ...signReferenceRow(),
      daemonSignature: sixtyFourCharacterString as unknown as Uint8Array,
    };
    expect(() => verifyRow(CANONICAL_ROW, stringSignature, DAEMON_PUBLIC_KEY)).not.toThrow();
    expect(verifyRow(CANONICAL_ROW, stringSignature, DAEMON_PUBLIC_KEY)).toStrictEqual({
      valid: false,
      failureMode: "signature_mismatch",
    });

    // THE DISCRIMINATING CASE, again: the row above short-circuits on its
    // honest `prev_hash` and never reaches the signature conjuncts at all. Zero
    // the chain columns and `isBytesOfLength` is the ONLY thing standing
    // between that string and an `.every` call it does not have — drop it and
    // this row throws a TypeError out of a function contracted never to raise
    // on stored data, which is how a tamper goes UNREPORTED.
    const stringSignatureOnZeroChain: SignedRow = {
      ...buildPlaceholderRow(),
      daemonSignature: sixtyFourCharacterString as unknown as Uint8Array,
    };
    expect(() =>
      verifyRow(CANONICAL_ROW, stringSignatureOnZeroChain, DAEMON_PUBLIC_KEY),
    ).not.toThrow();
    expect(verifyRow(CANONICAL_ROW, stringSignatureOnZeroChain, DAEMON_PUBLIC_KEY)).toStrictEqual({
      valid: false,
      failureMode: "hash_mismatch",
    });
  });

  it("names a refusal that was otherwise incidental — an all-zero signature IS well-formed", () => {
    // Why the explicit check is not redundant with "it would fail anyway".
    // `R` = 32 zero bytes decodes to a valid order-4 curve point and `S` = 0 is
    // a canonical scalar, so nothing refuses an all-zero signature on SHAPE.
    // Against a prime-order key the verification equation refuses it — but that
    // refusal is contingent on the resolved key, not on any named rule, and the
    // third assertion below is the proof: under noble's ZIP-215 DEFAULT the
    // identical all-zero signature VERIFIES against an all-zero (order-4) key.
    const allZeroSignature = new Uint8Array(ED25519_SIGNATURE_LENGTH);
    const allZeroPublicKey = new Uint8Array(CHAIN_HASH_LENGTH) as Ed25519PublicKey;

    expect(
      ed25519.verify(allZeroSignature, CANONICAL_ROW, DAEMON_PUBLIC_KEY, { zip215: false }),
    ).toBe(false);
    expect(ed25519.verify(allZeroSignature, CANONICAL_ROW, DAEMON_PUBLIC_KEY)).toBe(false);
    expect(ed25519.verify(allZeroSignature, CANONICAL_ROW, allZeroPublicKey)).toBe(true);
    expect(
      ed25519.verify(allZeroSignature, CANONICAL_ROW, allZeroPublicKey, { zip215: false }),
    ).toBe(false);

    // FOR THE PLACEHOLDER TRIO, `verifyRow` depends on none of that: stage 2
    // returns the named verdict before any curve arithmetic runs, so the answer
    // is the same whichever key the roster resolves. That key-independence is
    // the guarantee the explicit check buys, and it is what "incidental" versus
    // "guaranteed" means in concrete terms.
    expect(verifyRow(CANONICAL_ROW, buildPlaceholderRow(), DAEMON_PUBLIC_KEY)).toStrictEqual({
      valid: false,
      failureMode: "signature_placeholder",
    });
    expect(verifyRow(CANONICAL_ROW, buildPlaceholderRow(), allZeroPublicKey)).toStrictEqual({
      valid: false,
      failureMode: "signature_placeholder",
    });

    // THE GUARANTEE IS SCOPED TO THAT TRIO, AND THE THREE-COLUMN PREDICATE IS
    // WHAT SCOPED IT. An HONEST-CHAIN row carrying the same zeroed signature no
    // longer stops at stage 2, so its refusal is stage 4's and rests entirely
    // on `{ zip215: false }`: against the order-4 key, noble's DEFAULT returns
    // `true` (third assertion above) and this row would verify as `valid: true`
    // without that option. Not a hole this test papers over — the caller
    // RESOLVES `daemonPublicKey` from the participant roster, a small-order key
    // in the roster is its own bug, and `{ zip215: false }` is independently
    // pinned by the ZIP-215 block below. It is recorded because widening stage
    // 2 to all three columns MOVED this case out from behind it, and the next
    // reader should not have to rediscover that.
    const honestChainZeroSignature: SignedRow = {
      ...signReferenceRow(),
      daemonSignature: allZeroSignature,
    };
    expect(verifyRow(CANONICAL_ROW, honestChainZeroSignature, DAEMON_PUBLIC_KEY)).toStrictEqual({
      valid: false,
      failureMode: "signature_mismatch",
    });
    expect(verifyRow(CANONICAL_ROW, honestChainZeroSignature, allZeroPublicKey)).toStrictEqual({
      valid: false,
      failureMode: "signature_mismatch",
    });
  });

  it("leaves every pre-existing verdict unperturbed", () => {
    // The regression sweep the new branch has to survive: an honest row still
    // verifies, a genuinely tampered one still reports `hash_mismatch`, a
    // wrong-length public key still THROWS, and a wrong-length signature still
    // returns `signature_mismatch`. Each is pinned in its own test above; they
    // are re-asserted together here so a future edit to stage 2 that perturbs
    // one of them fails in the block that owns stage 2.
    const signed = signReferenceRow();
    expect(verifyRow(CANONICAL_ROW, signed, DAEMON_PUBLIC_KEY)).toStrictEqual({ valid: true });

    expect(
      verifyRow(
        CANONICAL_ROW,
        { ...signed, rowHash: withFlippedFirstBit(signed.rowHash) },
        DAEMON_PUBLIC_KEY,
      ),
    ).toStrictEqual({ valid: false, failureMode: "hash_mismatch" });

    expect(
      captureThrownMessage(() =>
        verifyRow(CANONICAL_ROW, signed, DAEMON_PUBLIC_KEY.slice(0, 31) as Ed25519PublicKey),
      ),
    ).toMatch(/requires a 32-byte Uint8Array public key/);

    expect(
      verifyRow(
        CANONICAL_ROW,
        { ...signed, daemonSignature: signed.daemonSignature.slice(0, 63) },
        DAEMON_PUBLIC_KEY,
      ),
    ).toStrictEqual({ valid: false, failureMode: "signature_mismatch" });
  });
});

// --------------------------------------------------------------------------
// The ZIP-215 forgery vector.
// --------------------------------------------------------------------------

// An order-1 (identity) point: little-endian y = 1 with a clear sign bit.
const ORDER_ONE_IDENTITY_PUBLIC_KEY: Ed25519PublicKey = hexToBytes(
  "0100000000000000000000000000000000000000000000000000000000000000",
) as Ed25519PublicKey;

// R = the same identity point, S = 0.
const IDENTITY_POINT_FORGED_SIGNATURE = hexToBytes(
  "0100000000000000000000000000000000000000000000000000000000000000" +
    "0000000000000000000000000000000000000000000000000000000000000000",
);

describe("ZIP-215 — the forgery `{ zip215: false }` exists to refuse", () => {
  it("noble's DEFAULTS accept the forgery against ANY message — this is the bug", () => {
    // ============================ DO NOT DELETE ============================
    // THIS BARE CALL IS NOT REDUNDANT WITH THE ASSERTIONS BELOW, AND
    // "SIMPLIFYING" IT AWAY SILENTLY GUTS THIS TEST.
    //
    // noble constructs its ed25519 wrapper with ZIP-215 semantics for consensus
    // compatibility, so a bare `ed25519.verify(...)` runs the PERMISSIVE rules.
    // Under those rules a small-order public key makes the `[8][k]A` term vanish
    // from the cofactored verification equation, so this ONE fixed (R, S) pair
    // verifies against ANY message: universal forgery for whichever `NodeId` has
    // that key on the roster. A daemon could then disown any row it had signed.
    //
    // `signer.ts` passes `{ zip215: false }` to refuse it. That option is the
    // entire fix. Without this assertion the module-level assertions below would
    // still pass if noble ever changed its default — and the suite would then be
    // silently asserting nothing, because a rejection is the default everywhere.
    // This call is what proves the strict flag is still load-bearing.
    // =======================================================================
    expect(
      ed25519.verify(IDENTITY_POINT_FORGED_SIGNATURE, CANONICAL_ROW, ORDER_ONE_IDENTITY_PUBLIC_KEY),
    ).toBe(true);

    // Same forged pair, an entirely unrelated message — the "universal" in
    // universal forgery.
    const unrelatedMessage = canonicalizeJson({ unrelated: "document" });
    expect(
      ed25519.verify(
        IDENTITY_POINT_FORGED_SIGNATURE,
        unrelatedMessage,
        ORDER_ONE_IDENTITY_PUBLIC_KEY,
      ),
    ).toBe(true);
  });

  it("verifyRow refuses the same triple", () => {
    // The row's chain columns are honest, so the digest check passes and
    // execution reaches the signature check — which is the check under test.
    const forgedRow: SignedRow = {
      ...signReferenceRow(),
      daemonSignature: IDENTITY_POINT_FORGED_SIGNATURE,
    };
    expect(verifyRow(CANONICAL_ROW, forgedRow, ORDER_ONE_IDENTITY_PUBLIC_KEY)).toStrictEqual({
      valid: false,
      failureMode: "signature_mismatch",
    });
  });

  it("verifyParticipantSignature refuses the same triple", () => {
    expect(
      verifyParticipantSignature(
        CANONICAL_ROW,
        IDENTITY_POINT_FORGED_SIGNATURE,
        ORDER_ONE_IDENTITY_PUBLIC_KEY,
      ),
    ).toBe(false);
  });

  it("does not reject any honestly-produced signature — strictness is a pure tightening", () => {
    // noble's `sign` always emits a canonical R and a reduced S, and a public
    // key derived from a clamped scalar is never small-order, so every honest
    // signature verifies identically under BOTH rule sets. This is the
    // false-negative control on the tightening above.
    const signed = signReferenceRow();
    expect(ed25519.verify(signed.daemonSignature, CANONICAL_ROW, DAEMON_PUBLIC_KEY)).toBe(true);
    expect(
      ed25519.verify(signed.daemonSignature, CANONICAL_ROW, DAEMON_PUBLIC_KEY, { zip215: false }),
    ).toBe(true);
    expect(verifyRow(CANONICAL_ROW, signed, DAEMON_PUBLIC_KEY)).toStrictEqual({ valid: true });

    const participantSignature = mintParticipantSignature(CANONICAL_ROW, PARTICIPANT_SIGNING_KEY);
    expect(ed25519.verify(participantSignature, CANONICAL_ROW, PARTICIPANT_PUBLIC_KEY)).toBe(true);
    expect(
      verifyParticipantSignature(CANONICAL_ROW, participantSignature, PARTICIPANT_PUBLIC_KEY),
    ).toBe(true);
  });
});

// --------------------------------------------------------------------------
// Error-channel discipline — throw for caller-resolved input, verdict for row data.
// --------------------------------------------------------------------------

describe("error channels — a throw and a verdict mean different things", () => {
  it("THROWS on a wrong-length public key — a key-resolution bug, not a tamper signal", () => {
    // The caller RESOLVES the public key from the participant roster, so a
    // wrong-shaped one is a plumbing bug (a truncated keystore read, a
    // mis-sliced roster record, T2.7's unvalidated cast). Folding it into
    // `signature_mismatch` would make T4.1 emit `audit_integrity_failed` on
    // EVERY row of EVERY session and discard the real cause.
    const truncatedPublicKey = DAEMON_PUBLIC_KEY.slice(0, 31) as Ed25519PublicKey;
    const signed = signReferenceRow();

    const rowMessage = captureThrownMessage(() =>
      verifyRow(CANONICAL_ROW, signed, truncatedPublicKey),
    );
    expect(rowMessage).toMatch(/requires a 32-byte Uint8Array public key/);
    expect(rowMessage).toMatch(/key-resolution bug, not a tampered row/);

    expect(
      captureThrownMessage(() =>
        verifyParticipantSignature(CANONICAL_ROW, signed.daemonSignature, truncatedPublicKey),
      ),
    ).toMatch(/requires a 32-byte Uint8Array public key/);
  });

  it("RETURNS signature_mismatch for a wrong-length signature — the asymmetry is deliberate", () => {
    // A signature comes off the STORED row, so a wrong-width one IS adversarial
    // data and belongs in the verdict, not in a throw. Pinned alongside the
    // public-key case above because the two look interchangeable and are not.
    const wrongLengthSignature: SignedRow = {
      ...signReferenceRow(),
      daemonSignature: signReferenceRow().daemonSignature.slice(0, 63),
    };
    expect(verifyRow(CANONICAL_ROW, wrongLengthSignature, DAEMON_PUBLIC_KEY)).toStrictEqual({
      valid: false,
      failureMode: "signature_mismatch",
    });
    expect(
      verifyParticipantSignature(
        CANONICAL_ROW,
        signReferenceRow().daemonSignature.slice(0, 63),
        DAEMON_PUBLIC_KEY,
      ),
    ).toBe(false);
  });

  it("maps a NON-BYTE stored row_hash to hash_mismatch without throwing", () => {
    // `SignedRow.rowHash` is declared `Uint8Array`, but the value crosses the
    // SQLite boundary where that declaration is a claim TypeScript never
    // checked. SQLite's BLOB declared type gives BLOB AFFINITY with no coercion,
    // and `length()` counts CHARACTERS for a TEXT value — so an at-rest attacker
    // can store 32 CHARACTERS, satisfy `CHECK(length(row_hash) = 32)`, and have
    // better-sqlite3 hand back a JS string.
    //
    // Unguarded, that string reaches `equalBytes`, whose `abytes` raises
    // TypeError, and the throw escapes — so T4.1 emits NO
    // `audit_integrity_failed` and the tamper goes UNREPORTED. Not-throwing is
    // therefore the load-bearing half of this assertion, not a detail.
    const thirtyTwoCharacterString = "0".repeat(32);
    expect(thirtyTwoCharacterString).toHaveLength(32);

    const stringRowHash: SignedRow = {
      ...signReferenceRow(),
      rowHash: thirtyTwoCharacterString as unknown as Uint8Array,
    };
    expect(() => verifyRow(CANONICAL_ROW, stringRowHash, DAEMON_PUBLIC_KEY)).not.toThrow();
    expect(verifyRow(CANONICAL_ROW, stringRowHash, DAEMON_PUBLIC_KEY)).toStrictEqual({
      valid: false,
      failureMode: "hash_mismatch",
    });
  });

  it("maps a NON-BYTE stored prev_hash to hash_mismatch without throwing", () => {
    // A different hole from the `rowHash` case, closed by the same guard: a
    // non-byte `prevHash` is not rejected by `equalBytes` at all — it is
    // silently COERCED by `TypedArray.prototype.set` while building the chain
    // input (the ArrayLike path runs `ToNumber` per character, so a hex string
    // lands as mostly zeros) and would yield a plausible-looking digest over
    // the wrong preimage.
    const stringPrevHash: SignedRow = {
      ...signReferenceRow(),
      prevHash: "0".repeat(32) as unknown as Uint8Array,
    };
    expect(() => verifyRow(CANONICAL_ROW, stringPrevHash, DAEMON_PUBLIC_KEY)).not.toThrow();
    expect(verifyRow(CANONICAL_ROW, stringPrevHash, DAEMON_PUBLIC_KEY)).toStrictEqual({
      valid: false,
      failureMode: "hash_mismatch",
    });
  });

  it("maps a wrong-WIDTH stored chain column to hash_mismatch without throwing", () => {
    const shortRowHash: SignedRow = {
      ...signReferenceRow(),
      rowHash: signReferenceRow().rowHash.slice(0, 31),
    };
    expect(verifyRow(CANONICAL_ROW, shortRowHash, DAEMON_PUBLIC_KEY)).toStrictEqual({
      valid: false,
      failureMode: "hash_mismatch",
    });
  });
});

// --------------------------------------------------------------------------
// The upstream premise — the `equalBytes` this module imports must refuse.
// --------------------------------------------------------------------------

describe("equalBytes — the upstream refusal stage 1's byte-ness clause is argued from", () => {
  it("THROWS a TypeError for a non-byte operand, in EITHER position", () => {
    // THE JUSTIFICATION FOR STAGE 1'S BYTE-NESS CLAUSE IS PACKAGE-SPECIFIC,
    // AND NOTHING ELSE PINS THE BEHAVIOR OF THE ONE IT RESOLVES TO.
    // `verifyRow`'s note argues that clause from a counterfactual: unguarded,
    // a stored TEXT `row_hash` reaches `equalBytes`, whose `abytes` raises a
    // TypeError, and the throw ESCAPES `verifyRow` — so T4.1 emits no
    // `audit_integrity_failed` and the tamper goes UNREPORTED. `maps a
    // NON-BYTE stored row_hash to hash_mismatch without throwing` above pins
    // the GUARDED outcome; this test pins the premise that counterfactual
    // rests on. The premise is a property of the `equalBytes` this module
    // IMPORTS rather than of the name: `@noble/curves/utils.js` opens its body
    // with an `abytes` call on BOTH operands, while `@noble/ciphers/utils.js`'s
    // same-named export — also in this repo's tree, imported by
    // `crypto-paseto`'s `v4-local.ts` — has no `abytes` call at all and goes
    // straight to `a.length`.
    //
    // WHAT AN IMPORT SWAP WOULD COST IS THE ARGUMENT, NOT THE VERDICT, AND
    // THIS COMMENT SHOULD NOT CLAIM MORE. Checked against
    // `@noble/ciphers@2.2.0` and RECORDED here rather than asserted below,
    // since that package is not a dependency of this one: its `equalBytes`
    // does not throw on a string, it COERCES. `.length` on a 32-CHARACTER
    // string is 32, so the length compare passes, and `character ^ byte` runs
    // `ToNumber` per character — `"0"` yields 0, and any non-numeric character
    // yields `NaN`, which `ToInt32` also sends to 0. The string is therefore
    // COMPARED, as the byte values its characters coerce to — all zeros for a
    // `"0"`-filled one — and answers `false` for any real digest, so
    // `verifyRow` still reports `hash_mismatch` and the security OUTCOME is
    // unchanged. It answers `true` only where the recomputed digest equals
    // those coerced values byte for byte, which needs every byte under 10 to
    // match a decimal character at all and is not a state an adversary reaches
    // against BLAKE3. So a swap would, WERE IT TO RESOLVE, silently falsify
    // a security-critical JUSTIFICATION with nothing going red. Making that
    // loud is this test's whole job — it does not stand between anyone and a
    // vulnerability, and should not be read as though it does.
    //
    // THE GATE IS PARTIAL, AND WHAT CLOSES THE NAMED HALF IS THE DEPENDENCY
    // BOUNDARY, NOT THIS SUITE. This file imports the SAME specifier
    // `signer.ts` does, from the same package, so both resolve to the same
    // module and the pin travels with the production import across an
    // UPSTREAM change — `package.json` declares a floating `^2` and this was
    // verified against `@noble/curves@2.2.0`, so the resolution drift that
    // range permits is exactly what is now gated. What this suite does not
    // see is `signer.ts`'s own binding: nothing here asserts which module its
    // `equalBytes` comes from. For the `@noble/ciphers` swap, that costs
    // nothing today, because `.npmrc`'s `node-linker=isolated` (ADR-022)
    // keeps a package this one does not declare out of its resolution tree —
    // the repointed specifier does not RESOLVE from `packages/runtime-daemon`,
    // verified `ERR_MODULE_NOT_FOUND` against a resolving
    // `@noble/curves/utils.js` control. The module fails to LOAD rather than
    // behaving differently.
    //
    // THAT IS A DEPENDENCY-GRAPH PROPERTY, SO IT HOLDS ONLY WHILE THE GRAPH
    // DOES. Adding `@noble/ciphers` to this package's `dependencies`, for any
    // reason, makes the specifier resolve and reopens the swap with nothing
    // here to catch it. And the boundary speaks only to packages this one
    // does not declare: a repoint at any specifier that DOES resolve from
    // here — a local hand-rolled `equalBytes`, say — is still unseen by this
    // suite.
    const honestRowHash = signReferenceRow().rowHash;
    const thirtyTwoCharacterString = "0".repeat(CHAIN_HASH_LENGTH);
    expect(thirtyTwoCharacterString).toHaveLength(CHAIN_HASH_LENGTH);

    // The untrusted value is operand `b` TODAY — `verifyRow` compares its
    // freshly recomputed digest against `row.rowHash`, in that order. BOTH
    // positions are pinned so the premise is argument-ORDER-independent: a
    // refactor swapping the two operands could otherwise move the stored value
    // into an unpinned position. This is NOT about `prev_hash`, which never
    // reaches `equalBytes` at all — its hole is the silent
    // `TypedArray.prototype.set` coercion the same stage-1 clause closes.
    expect(() =>
      equalBytes(honestRowHash, thirtyTwoCharacterString as unknown as Uint8Array),
    ).toThrow(TypeError);
    expect(() =>
      equalBytes(thirtyTwoCharacterString as unknown as Uint8Array, honestRowHash),
    ).toThrow(TypeError);

    // The CLASS is asserted rather than a bare "it throws" because
    // `signer.ts`'s note names it, and `abytes` uses the class to separate its
    // two refusals: `TypeError` for a value that is not bytes, `RangeError`
    // for bytes of the wrong length. `equalBytes` calls it WITHOUT a length
    // argument, so only the first arm is reachable here — which is also why
    // the wrong-width control below answers `false` rather than throwing.
    //
    // The message substring is a PROVENANCE check rather than a wording pin —
    // it keeps the assertion from being satisfied by some other TypeError the
    // call could raise (a non-callable export) for a reason unrelated to the
    // premise.
    expect(
      captureThrownMessage(() =>
        equalBytes(honestRowHash, thirtyTwoCharacterString as unknown as Uint8Array),
      ),
    ).toMatch(/expected Uint8Array/);

    // CONTROLS — without them an `equalBytes` that threw unconditionally would
    // satisfy every assertion above. It still DECIDES for real byte operands,
    // still accepts the `Buffer` better-sqlite3 hands back for an untampered
    // BLOB (the honest read path, which the guard must leave undisturbed), and
    // still answers a WRONG-WIDTH byte operand with `false` rather than a
    // throw — that last one is what makes the TypeError above specifically a
    // byte-NESS refusal, which is the clause under test.
    expect(equalBytes(honestRowHash, Uint8Array.from(honestRowHash))).toBe(true);
    expect(equalBytes(honestRowHash, withFlippedFirstBit(honestRowHash))).toBe(false);
    expect(equalBytes(honestRowHash, Buffer.from(honestRowHash))).toBe(true);
    expect(equalBytes(honestRowHash, honestRowHash.slice(0, CHAIN_HASH_LENGTH - 1))).toBe(false);
  });
});

// --------------------------------------------------------------------------
// Participant attestation — the two signature domains must not cross-validate.
// --------------------------------------------------------------------------

describe("daemon and participant signatures do not cross-validate", () => {
  it("mints a participant signature over the same canonical bytes (I-006-2-06)", () => {
    expect(bytesToHex(mintParticipantSignature(CANONICAL_ROW, PARTICIPANT_SIGNING_KEY))).toBe(
      EXPECTED_PARTICIPANT_SIGNATURE_HEX,
    );
    expect(
      verifyParticipantSignature(
        CANONICAL_ROW,
        mintParticipantSignature(CANONICAL_ROW, PARTICIPANT_SIGNING_KEY),
        PARTICIPANT_PUBLIC_KEY,
      ),
    ).toBe(true);
  });

  it("fails verifyParticipantSignature for a signature minted with the DAEMON key", () => {
    // The documented key-confusion residue: mis-plumbing the daemon key into
    // `mintParticipantSignature` is FAIL-CLOSED rather than a silent forgery,
    // because the read side resolves the PARTICIPANT's public key. Pinning it
    // keeps that argument true.
    const daemonKeyedAttestation = mintParticipantSignature(CANONICAL_ROW, DAEMON_SIGNING_KEY);
    expect(
      verifyParticipantSignature(CANONICAL_ROW, daemonKeyedAttestation, PARTICIPANT_PUBLIC_KEY),
    ).toBe(false);
    // Control: it is a VALID signature — just under the wrong domain's key.
    expect(
      verifyParticipantSignature(CANONICAL_ROW, daemonKeyedAttestation, DAEMON_PUBLIC_KEY),
    ).toBe(true);
  });

  it("fails verifyRow for a daemon_signature minted with the PARTICIPANT key", () => {
    // The mirror direction. `signRow` holds no participant key, so this row is
    // assembled by hand to stand in for a mis-routed composition root.
    const participantKeyedRow: SignedRow = {
      ...signReferenceRow(),
      daemonSignature: mintParticipantSignature(CANONICAL_ROW, PARTICIPANT_SIGNING_KEY),
    };
    expect(verifyRow(CANONICAL_ROW, participantKeyedRow, DAEMON_PUBLIC_KEY)).toStrictEqual({
      valid: false,
      failureMode: "signature_mismatch",
    });
    // Control: the same bytes verify under the participant's own key.
    expect(verifyRow(CANONICAL_ROW, participantKeyedRow, PARTICIPANT_PUBLIC_KEY)).toStrictEqual({
      valid: true,
    });
  });
});
