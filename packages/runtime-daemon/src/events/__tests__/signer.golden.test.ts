// Golden-vector suite for the BLAKE3 hash-chain + Ed25519 row signer
// (Plan-006 T2.2).
//
// SCOPE NOTE — WHY THIS FILE EXISTS ALONGSIDE `canonicalizer.golden.test.ts`.
// Plan-006's Phase 2 names exactly one test task for the crypto core, T2.3, and
// scopes it to the canonicalizer (its `File:` row names
// `canonicalizer.golden.test.ts`; its `Verifies invariant:` line lists only
// I-006-1-03 and I-006-2-03). T2.5 is the post-shred property suite and is
// scoped to T2.4's PII codec. That leaves `signer.ts` — which owns the two
// tamper-evidence commitments on every row — with no task unit-testing it. The
// behaviors pinned below are security-critical and several encode a specific
// defect closed in review (see the ZIP-215 vector), so they are pinned here as
// a T2.3 sibling rather than left unpinned pending a plan true-up.
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

const RFC_8032_TEST_1_SECRET_KEY_HEX =
  "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
const RFC_8032_TEST_1_PUBLIC_KEY_HEX =
  "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";
const RFC_8032_TEST_2_SECRET_KEY_HEX =
  "4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb";
const RFC_8032_TEST_2_PUBLIC_KEY_HEX =
  "3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c";

const DAEMON_SIGNING_KEY: Ed25519PrivateKey = hexToBytes(
  RFC_8032_TEST_1_SECRET_KEY_HEX,
) as Ed25519PrivateKey;
const DAEMON_PUBLIC_KEY: Ed25519PublicKey = ed25519.getPublicKey(
  DAEMON_SIGNING_KEY,
) as Ed25519PublicKey;

const PARTICIPANT_SIGNING_KEY: Ed25519PrivateKey = hexToBytes(
  RFC_8032_TEST_2_SECRET_KEY_HEX,
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
    // message, never from an RNG. This is what makes T2.6's backfill migration
    // safely re-runnable.
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
    // `TypedArray.prototype.set`. T2.6's backfill re-reads a stored `row_hash`
    // out of SQLite, where a `BLOB` column can genuinely hand back a string.
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
    // CHECK ORDER IS SPEC ORDER AND IT IS OBSERVABLE: chain first, signature
    // second, first failure wins.
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
