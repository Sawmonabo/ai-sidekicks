// Daemon signing-key custody suite (Plan-006 T2.7 — `signing-key-source.ts`).
//
// WHY THIS FILE EXISTS. `signing-key-source.ts` is the one module in the
// workspace that holds daemon-private key material and the one site where key
// bytes enter the type system, and no Phase-2 task declared a suite for it. The
// six properties below are the ones that would fail silently and expensively:
//
//   1. THE PUBLIC/PRIVATE SPLIT IS A SECURITY BOUNDARY. `create` resolves to the
//      PUBLIC key and nothing else; the private half is reachable only through
//      the signer-local `read`. A regression that widened `create`'s result
//      would leak daemon-private material into CP-006-7's provisioning
//      call-sites (the composition-root caller, leg A; the post-attach roster
//      registrar, leg B) — a boundary crossing the T2.7 row forbids outright,
//      and one no downstream test would notice.
//   2. THE SEAL IS AN INJECTED BOUNDARY, so a private key at rest is never
//      cleartext and a test never touches a real keystore. The fakes below are
//      what a headless CI box gets instead of Secret Service.
//   3. `create` IS EXACTLY ONCE PER SESSION, enforced by the `session_id`
//      PRIMARY KEY against a plain `INSERT` — never `INSERT OR REPLACE`. A
//      silent re-key is the worst outcome in the module: every
//      `daemon_signature` already written under the old key would verify
//      against nothing, producing an UNTAMPERED log that fails forever.
//   4. `read` HANDS BACK A COPY, NEVER A VIEW OVER THE SEALER'S BUFFER. The
//      seal boundary is injected, so `unseal` may legitimately return a scratch
//      array it reuses; branded in place, that array is overwritten under a key
//      the append path still holds across an `await`, and the row is signed
//      with the wrong scalar. The result is a signature no roster public key
//      verifies — which at the verifier is indistinguishable from tampering.
//   5. `read` HANDS BACK THIS ROW'S KEY, PROVED AGAINST THIS ROW'S PUBLIC HALF.
//      The same injected boundary is documented as free to IGNORE `sessionId`
//      (the interface fixes no format, so it cannot require the AAD binding), so
//      a `sealed_private_key` blob copied from one row onto another unseals
//      cleanly. Branded unchecked, `read` returns the OTHER session's key and
//      every row this session appends is signed under a key the roster does not
//      hold for this node — `signature_mismatch` at the verifier, the
//      possible-tampering verdict, on every row signed with it. `create` wrote
//      both halves of one keypair into one row, so the row itself is what
//      refutes the substitution.
//   6. THE SEALER'S RESULT IS UNCHECKED INPUT, AND THE ROW IT WOULD WRITE
//      CANNOT BE UNDONE. `seal` crosses the same CP-006-11 injection boundary,
//      so an empty or non-byte result is a claim nothing verified — and
//      `BLOB NOT NULL` refuses NULL and nothing else, so such a value
//      PERSISTS. The `session_id` PRIMARY KEY then bars the re-provisioning
//      that would fix it, leaving a session whose public half the roster holds
//      and whose private half exists nowhere: unrecoverable, where every other
//      failure in this module is at worst a refusal. Both sides are covered
//      below, because they cover different rows — `create` refuses before the
//      INSERT, and `read` refuses a zero-length blob that a build predating
//      that guard already wrote. The same seam carries a WORSE failure that
//      every shape check admits: a no-op sealer echoing the seed back persists
//      the Ed25519 secret in CLEARTEXT under a column readers treat as sealed,
//      so `create` refuses that identity case too — a heuristic that claims
//      only "not literally the seed", never "sealed".
//
// TESTED THROUGH THE PUBLIC SURFACE AND A REAL DATABASE. The narrowing helpers
// (`toEd25519PublicKey` / `toEd25519PrivateKey` / `assertEd25519KeyWidth`) are
// module-private by design, so they are exercised through the two paths that
// call them rather than imported. The database is a real in-memory SQLite on
// the shipped migrations, so the `daemon_signing_keys` DDL — BLOB columns, the
// PK, the NOT NULLs — participates in every assertion; its SHAPE is pinned
// separately by the `0005-daemon-signing-keys migration shape` block in
// `session/__tests__/migration-shape.test.ts`.
//
// ONE ROLE OF `assertEd25519KeyWidth` IS NOT REACHABLE FROM HERE, AND THAT IS
// STATED RATHER THAN PAPERED OVER. The "private key" role is driven below
// through a short-returning / non-byte `unseal`, which is a realistic
// implementor bug at the injected boundary. The "public key" role is reached
// only from `ed25519.keygen()`'s own output, and `@noble/curves`' `ed25519`
// export is a FROZEN object whose `keygen` property is non-writable and
// non-configurable — so `vi.spyOn` cannot stand in a short-returning keygen,
// and module-level mocking of a crypto library to reach one branch would buy
// less than it costs. The only behaviour distinct to that role is the word
// "public key" in the message; the guard itself is the same call.
//
// Refs: `Spec-022 §Daemon Master Key`, `ADR-004 §Decision`,
// `Spec-006 §Integrity Protocol`,
// `docs/architecture/security-architecture.md §Per-Event Daemon Signature`.
import { SessionIdSchema } from "@ai-sidekicks/contracts";
import type { SessionId } from "@ai-sidekicks/contracts";
import { ed25519 } from "@noble/curves/ed25519.js";
import type { Database as DatabaseType } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase } from "../../session/migration-runner.js";
import { canonicalizeJson } from "../canonicalizer.js";
import type { CanonicalBytes } from "../canonicalizer.js";
import { GENESIS_PREV_HASH, signRow, verifyRow } from "../signer.js";
import type { Ed25519PrivateKey, SignedRow } from "../signer.js";
import { OsKeystoreSealedDaemonSigningKeySource } from "../signing-key-source.js";
import type {
  DaemonSigningKeyProvisioner,
  DaemonSigningKeySealer,
  DaemonSigningKeySource,
} from "../signing-key-source.js";

// --------------------------------------------------------------------------
// Helpers.
// --------------------------------------------------------------------------

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

// --------------------------------------------------------------------------
// The injected seal boundary — fakes, because the real one is an OS keystore.
// --------------------------------------------------------------------------
//
// The envelope format below is INVENTED BY THIS TEST and is not a claim about
// any real one: `signing-key-source.ts` deliberately fixes no byte format (see
// its "What is NOT here" note), so a fake is free to choose anything that
// satisfies the one contract the interface does fix —
// `unseal(sessionId, await seal(sessionId, key))` resolves to bytes equal to
// `key`. It binds `sessionId` INTO the envelope on purpose: that is the AAD
// shape the interface documents as available-but-unenforced, and binding it
// here is what makes the cross-session-replay test below meaningful rather
// than decorative.

const FAKE_SEAL_PREFIX = "fake-seal:v1:";
/** The {@link SessionIdIgnoringFakeSealer} envelope — same shape, no session id in it. */
const UNBOUND_SEAL_PREFIX = "fake-seal-unbound:v1:";

function buildFakeEnvelope(sessionId: SessionId, privateKey: Uint8Array): Uint8Array {
  return utf8Encoder.encode(`${FAKE_SEAL_PREFIX}${sessionId}:${bytesToHex(privateKey)}`);
}

function openFakeEnvelope(sessionId: SessionId, sealedPrivateKey: Uint8Array): Uint8Array {
  const text: string = utf8Decoder.decode(sealedPrivateKey);
  const expectedPrefix = `${FAKE_SEAL_PREFIX}${sessionId}:`;
  if (!text.startsWith(expectedPrefix)) {
    // What a real AEAD would do on an AAD mismatch: refuse, rather than hand
    // back the wrong session's key material.
    throw new Error(`fake sealer: envelope is not bound to session ${sessionId}`);
  }
  return hexToBytes(text.slice(expectedPrefix.length));
}

/**
 * The default fake: a faithful round trip that RECORDS both sides.
 *
 * `seal` copies the seed it is handed. That copy is not incidental —
 * `create` zero-fills `keyPair.secretKey` in its `finally`, so a retained VIEW
 * would read back as 32 zero bytes by the time a test inspected it, and the
 * assertion would silently become "the seed was zeroed" instead of "the seed
 * was sealed". The scrub itself is asserted by {@link RetainingFakeSealer},
 * which retains on purpose.
 */
class RecordingFakeSealer implements DaemonSigningKeySealer {
  readonly sealCalls: Array<{ sessionId: SessionId; privateKey: Uint8Array }> = [];
  readonly unsealCalls: Array<{ sessionId: SessionId; sealedPrivateKey: Uint8Array }> = [];

  seal(sessionId: SessionId, privateKey: Uint8Array): Promise<Uint8Array> {
    this.sealCalls.push({ sessionId, privateKey: Uint8Array.from(privateKey) });
    return Promise.resolve(buildFakeEnvelope(sessionId, privateKey));
  }

  unseal(sessionId: SessionId, sealedPrivateKey: Uint8Array): Promise<Uint8Array> {
    this.unsealCalls.push({ sessionId, sealedPrivateKey: Uint8Array.from(sealedPrivateKey) });
    return Promise.resolve(openFakeEnvelope(sessionId, sealedPrivateKey));
  }
}

/**
 * Binds NOTHING to the session — the implementation `DaemonSigningKeySealer`
 * explicitly permits, and the one the cross-row copy test needs.
 *
 * Not a strawman. That interface passes `sessionId` on both sides so an
 * implementation CAN use it as AEAD associated data and says in terms that it
 * cannot require the binding, having fixed no byte format; a sealer that
 * round-trips faithfully while ignoring the argument satisfies every clause of
 * the contract. What it gives up is the property the binding buys — a blob
 * copied between rows opens under it — which is exactly the input
 * `read`'s public-key check has to survive.
 */
class SessionIdIgnoringFakeSealer implements DaemonSigningKeySealer {
  seal(_sessionId: SessionId, privateKey: Uint8Array): Promise<Uint8Array> {
    return Promise.resolve(utf8Encoder.encode(`${UNBOUND_SEAL_PREFIX}${bytesToHex(privateKey)}`));
  }

  unseal(_sessionId: SessionId, sealedPrivateKey: Uint8Array): Promise<Uint8Array> {
    const text: string = utf8Decoder.decode(sealedPrivateKey);
    if (!text.startsWith(UNBOUND_SEAL_PREFIX)) {
      throw new Error(`unbound fake sealer: not one of its envelopes`);
    }
    return Promise.resolve(hexToBytes(text.slice(UNBOUND_SEAL_PREFIX.length)));
  }
}

/** Aliases the seed it is handed — the driver for the post-seal scrub assertion. */
class RetainingFakeSealer implements DaemonSigningKeySealer {
  retainedSeed: Uint8Array | null = null;

  seal(sessionId: SessionId, privateKey: Uint8Array): Promise<Uint8Array> {
    this.retainedSeed = privateKey;
    return Promise.resolve(buildFakeEnvelope(sessionId, privateKey));
  }

  unseal(sessionId: SessionId, sealedPrivateKey: Uint8Array): Promise<Uint8Array> {
    return Promise.resolve(openFakeEnvelope(sessionId, sealedPrivateKey));
  }
}

/** Fails the seal, retaining the seed so the `finally` scrub stays observable. */
class ThrowingFakeSealer implements DaemonSigningKeySealer {
  retainedSeed: Uint8Array | null = null;

  seal(_sessionId: SessionId, privateKey: Uint8Array): Promise<Uint8Array> {
    this.retainedSeed = privateKey;
    return Promise.reject(new Error("keystore unavailable: no Secret Service on this host"));
  }

  unseal(_sessionId: SessionId, _sealedPrivateKey: Uint8Array): Promise<Uint8Array> {
    return Promise.reject(new Error("keystore unavailable: no Secret Service on this host"));
  }
}

/**
 * Fails by RETURNING rather than by throwing: `seal` resolves to whatever the
 * test names. The seal-side counterpart of {@link FixedUnsealResultSealer}, and
 * the shape a stub at the CP-006-11 boundary actually takes — an implementation
 * that is wired but not yet implemented resolves with something, and its
 * declared return type is a claim nothing on this side checked.
 *
 * IT ALIASES THE SEED RATHER THAN COPYING IT, unlike {@link RecordingFakeSealer}
 * and for the reason that fake's note gives in reverse: only a RETAINED VIEW can
 * show that `create` zeroed the array it allocated. That assertion is the one
 * that distinguishes a guard placed inside the `try` from one placed after it —
 * both refuse the value, but only the first still reaches the `finally`.
 */
class FixedSealResultSealer implements DaemonSigningKeySealer {
  retainedSeed: Uint8Array | null = null;
  readonly #sealResult: unknown;

  constructor(sealResult: unknown) {
    this.#sealResult = sealResult;
  }

  seal(_sessionId: SessionId, privateKey: Uint8Array): Promise<Uint8Array> {
    this.retainedSeed = privateKey;
    return Promise.resolve(this.#sealResult as Uint8Array);
  }

  unseal(sessionId: SessionId, sealedPrivateKey: Uint8Array): Promise<Uint8Array> {
    return Promise.resolve(openFakeEnvelope(sessionId, sealedPrivateKey));
  }
}

/**
 * Hands the seed straight back — the no-op sealer, and the shape a
 * wired-but-unimplemented CP-006-11 boundary most plausibly takes. Its output
 * clears every shape check in the module: non-empty, `Uint8Array`, 32 bytes.
 *
 * IT RETURNS A COPY RATHER THAN THE ARGUMENT, which is what makes the test
 * meaningful: the guard compares CONTENT, so a stub echoing by reference is
 * caught a fortiori. The seed itself is retained for the scrub assertion, as
 * with the sealers above.
 */
class CleartextEchoingSealer implements DaemonSigningKeySealer {
  retainedSeed: Uint8Array | null = null;

  seal(_sessionId: SessionId, privateKey: Uint8Array): Promise<Uint8Array> {
    this.retainedSeed = privateKey;
    return Promise.resolve(Uint8Array.from(privateKey));
  }

  unseal(sessionId: SessionId, sealedPrivateKey: Uint8Array): Promise<Uint8Array> {
    return Promise.resolve(openFakeEnvelope(sessionId, sealedPrivateKey));
  }
}

/** Returns whatever the test names, so the unseal-side width guard is reachable. */
class FixedUnsealResultSealer implements DaemonSigningKeySealer {
  readonly #unsealResult: unknown;

  constructor(unsealResult: unknown) {
    this.#unsealResult = unsealResult;
  }

  seal(sessionId: SessionId, privateKey: Uint8Array): Promise<Uint8Array> {
    return Promise.resolve(buildFakeEnvelope(sessionId, privateKey));
  }

  unseal(_sessionId: SessionId, _sealedPrivateKey: Uint8Array): Promise<Uint8Array> {
    // Deliberately a value the declared type forbids: `unseal` crosses an
    // injection boundary this package neither owns nor imports, so its declared
    // return type is a claim nothing checked.
    return Promise.resolve(this.#unsealResult as Uint8Array);
  }
}

/**
 * Unseals into ONE array it reuses on every call — the shape the read-side copy
 * defends against, and an entirely legitimate implementation.
 *
 * It is not a contrived fake: `DaemonSigningKeySealer.unseal` fixes no byte
 * format and no allocation discipline, and an implementation that avoids
 * allocating fresh secret-bearing memory per call is doing the hygienic thing,
 * not the careless one. What makes it dangerous is on the CONSUMER's side —
 * `read` is async, so a branded key is held across an `await` by every caller,
 * and the next `unseal` writes through it. That is why the fix is a copy here
 * rather than a prohibition there.
 */
class ScratchBufferReusingSealer implements DaemonSigningKeySealer {
  /** The single buffer every `unseal` returns. Exposed so a test can assert identity. */
  readonly scratch: Uint8Array = new Uint8Array(32);

  seal(sessionId: SessionId, privateKey: Uint8Array): Promise<Uint8Array> {
    return Promise.resolve(buildFakeEnvelope(sessionId, privateKey));
  }

  unseal(sessionId: SessionId, sealedPrivateKey: Uint8Array): Promise<Uint8Array> {
    this.scratch.set(openFakeEnvelope(sessionId, sealedPrivateKey));
    return Promise.resolve(this.scratch);
  }
}

// --------------------------------------------------------------------------
// Fixtures.
// --------------------------------------------------------------------------

const SESSION_ONE: SessionId = SessionIdSchema.parse("0192f3a4-5b6c-7d8e-9f01-234567890abc");
const SESSION_TWO: SessionId = SessionIdSchema.parse("0192f3a4-5b6c-7d8e-9f01-fedcba098765");
const FIXTURE_CREATED_AT = "2026-07-08T00:00:00.000Z";

interface StoredSigningKeyRow {
  readonly session_id: string;
  readonly public_key: unknown;
  readonly sealed_private_key: unknown;
  readonly created_at: string;
  readonly rotated_at: string | null;
}

function readSigningKeyRows(database: DatabaseType): ReadonlyArray<StoredSigningKeyRow> {
  return database
    .prepare(
      `SELECT session_id, public_key, sealed_private_key, created_at, rotated_at
         FROM daemon_signing_keys ORDER BY session_id`,
    )
    .all() as ReadonlyArray<StoredSigningKeyRow>;
}

describe("OsKeystoreSealedDaemonSigningKeySource", () => {
  let database: DatabaseType;
  let sealer: RecordingFakeSealer;
  let keySource: DaemonSigningKeySource;

  beforeEach(() => {
    database = openDatabase(":memory:");
    sealer = new RecordingFakeSealer();
    keySource = new OsKeystoreSealedDaemonSigningKeySource(database, sealer, {
      now: () => FIXTURE_CREATED_AT,
    });
  });

  afterEach(() => {
    database.close();
  });

  // ========================================================================
  // The public/private split — the security boundary (CP-006-7).
  // ========================================================================

  describe("create resolves to the public key and nothing else", () => {
    it("returns exactly one member, `publicKey`, and no private material", async () => {
      const created = await keySource.create(SESSION_ONE);

      // The runtime half of the boundary. A widened result — `{ publicKey,
      // privateKey }`, a `secretKey` echo added "for convenience", a debug
      // `sealedPrivateKey` — is exactly the regression CP-006-7's provisioning
      // caller could not detect, because it would simply receive more than it
      // reads.
      expect(Object.keys(created)).toEqual(["publicKey"]);
      expect(created.publicKey).toBeInstanceOf(Uint8Array);
      expect(created.publicKey.length).toBe(32);
    });

    it("hands the provisioning caller a public key that is genuinely this session's", async () => {
      const { publicKey } = await keySource.create(SESSION_ONE);

      // The seed the sealer saw is the private half of the SAME keypair. This is
      // what makes the returned value a usable roster registration rather than
      // 32 arbitrary bytes: the roster's verifier resolves this key by NodeId.
      const sealedSeed: Uint8Array | undefined = sealer.sealCalls[0]?.privateKey;
      expect(sealedSeed).toBeDefined();
      expect(ed25519.getPublicKey(sealedSeed ?? new Uint8Array(32))).toEqual(publicKey);
    });

    it("keeps `read` off the provisioner surface at compile time", async () => {
      // The structural half of the split (TS2339). `DaemonSigningKeyProvisioner`
      // declares `create` and nothing else, so a call site annotated with it
      // cannot reach the private half — and no cast helper or overload is
      // exported to widen back. Self-verifying: an UNUSED `@ts-expect-error` is
      // itself a TS2578 error, so if `read` were ever added to the narrow
      // interface the `tsc -p tsconfig.test.json` pass fails.
      const provisioner: DaemonSigningKeyProvisioner = keySource;

      // @ts-expect-error `read` is not on DaemonSigningKeyProvisioner — daemon-private signing material never crosses the provisioning boundary (CP-006-7)
      const unreachableRead: unknown = provisioner.read;

      // THE SPLIT IS A TYPE-LEVEL BOUNDARY AND THE ASSERTION SAYS SO. The
      // module header is explicit that TypeScript is structurally typed, so the
      // ONE instance the composition root builds satisfies both interfaces at
      // once — `read` is therefore present at runtime on both handles, and a
      // runtime absence check would be asserting something the design never
      // claimed. What the directive above proves is the thing that IS claimed:
      // code annotated with the narrow type cannot legally reach it.
      expect(typeof unreachableRead).toBe("function");
      expect(typeof keySource.read).toBe("function");
      // The narrow handle still provisions, so the probe above is a reachability
      // claim about `read` and not about a broken binding.
      await expect(provisioner.create(SESSION_TWO)).resolves.toHaveProperty("publicKey");
    });

    it("persists the public key in the clear and the private key only sealed", async () => {
      const { publicKey } = await keySource.create(SESSION_ONE);

      const rows = readSigningKeyRows(database);
      expect(rows).toHaveLength(1);
      const row: StoredSigningKeyRow | undefined = rows[0];
      expect(row?.session_id).toBe(SESSION_ONE);
      expect(Uint8Array.from(row?.public_key as Uint8Array)).toEqual(Uint8Array.from(publicKey));
      // The injected clock, not `new Date()` — the constructor's `deps.now` seam.
      expect(row?.created_at).toBe(FIXTURE_CREATED_AT);
      // No rotate operation ships in V1 (the ADR-010 forward declaration).
      expect(row?.rotated_at).toBeNull();

      // THE AT-REST ASSERTION. The stored private half is the SEALER's output,
      // and the raw seed does not appear in the column under any encoding. A
      // regression that persisted `keyPair.secretKey` directly would still round
      // trip through a fake sealer that ignores its input, so the check is on
      // the stored bytes rather than on the round trip.
      const storedSealed = Uint8Array.from(row?.sealed_private_key as Uint8Array);
      const seed: Uint8Array = sealer.sealCalls[0]?.privateKey ?? new Uint8Array(0);
      expect(seed.length).toBe(32);
      expect(storedSealed).toEqual(buildFakeEnvelope(SESSION_ONE, seed));
      expect(bytesToHex(storedSealed)).not.toBe(bytesToHex(seed));
      expect(utf8Decoder.decode(storedSealed)).toContain(FAKE_SEAL_PREFIX);
    });

    it("passes the session id to the sealer so an implementation can bind it as AAD", async () => {
      await keySource.create(SESSION_ONE);
      expect(sealer.sealCalls).toHaveLength(1);
      expect(sealer.sealCalls[0]?.sessionId).toBe(SESSION_ONE);
    });

    it("scrubs the generated seed after sealing", async () => {
      // The `finally` hygiene, made observable by a sealer that ALIASES rather
      // than copies. Honest about what it proves: the array this module
      // allocated is zeroed, which is all the source claims (V8 copies, swap,
      // and a retaining sealer's own copy are all outside its reach — and this
      // fake is that last case, deliberately).
      const retainingSealer = new RetainingFakeSealer();
      const scrubbedSource = new OsKeystoreSealedDaemonSigningKeySource(database, retainingSealer, {
        now: () => FIXTURE_CREATED_AT,
      });

      await scrubbedSource.create(SESSION_ONE);

      expect(retainingSealer.retainedSeed).not.toBeNull();
      expect(retainingSealer.retainedSeed?.length).toBe(32);
      expect(Array.from(retainingSealer.retainedSeed ?? []).every((byte) => byte === 0)).toBe(true);
    });
  });

  // ========================================================================
  // Seal-before-INSERT ordering.
  // ========================================================================

  describe("a failing sealer leaves no row", () => {
    it("rejects, writes nothing, and still scrubs the seed", async () => {
      const throwingSealer = new ThrowingFakeSealer();
      const failingSource: DaemonSigningKeySource = new OsKeystoreSealedDaemonSigningKeySource(
        database,
        throwingSealer,
        { now: () => FIXTURE_CREATED_AT },
      );

      await expect(failingSource.create(SESSION_ONE)).rejects.toThrow(/keystore unavailable/);

      // Sealed BEFORE the INSERT on purpose: write-then-seal could persist a
      // session whose private half was never sealed, and the PRIMARY KEY would
      // then block the retry — an unrecoverable state reached by an ordering
      // choice.
      expect(readSigningKeyRows(database)).toHaveLength(0);
      // The `try` opens ahead of the seal, so the throwing path reaches the
      // scrub too — which is where a plaintext seed would otherwise stay
      // reachable for the whole unwind.
      expect(Array.from(throwingSealer.retainedSeed ?? [1]).every((byte) => byte === 0)).toBe(true);

      // And the retry is genuinely open, because no row was left behind.
      const workingSource: DaemonSigningKeySource = new OsKeystoreSealedDaemonSigningKeySource(
        database,
        sealer,
        { now: () => FIXTURE_CREATED_AT },
      );
      await expect(workingSource.create(SESSION_ONE)).resolves.toHaveProperty("publicKey");
    });
  });

  // ========================================================================
  // The seal RESULT — the CP-006-11 shape guard.
  // ========================================================================
  //
  // The block above covers a sealer that fails by THROWING, which is loud. This
  // one covers the sealer that fails by RETURNING, which is silent and worse:
  // `sealed_private_key` is `BLOB NOT NULL`, NOT NULL refuses only NULL, and
  // `Buffer.from` coerces rather than refuses — so an empty or non-byte result
  // lands as a row the DDL is happy with. That row is unrecoverable, because
  // the `session_id` PRIMARY KEY then blocks the re-provisioning that would
  // replace it. Each test below therefore asserts three things, and the last
  // two are the ones that map to the failure rather than to the guard: that the
  // seed was still scrubbed (the guard is INSIDE the `try`), and that the
  // session can still be provisioned afterwards.

  describe("a sealer returning a bad blob leaves no row", () => {
    it("refuses an empty seal result, scrubs the seed, and leaves the retry open", async () => {
      const emptyResultSealer = new FixedSealResultSealer(new Uint8Array(0));
      const source: DaemonSigningKeySource = new OsKeystoreSealedDaemonSigningKeySource(
        database,
        emptyResultSealer,
        { now: () => FIXTURE_CREATED_AT },
      );

      await expect(source.create(SESSION_ONE)).rejects.toThrow(
        /DaemonSigningKeySealer\.seal must return a non-empty Uint8Array for daemon_signing_keys\.sealed_private_key; received 0 bytes\./,
      );

      // Refused ahead of the INSERT, so the PRIMARY KEY is still free.
      expect(readSigningKeyRows(database)).toHaveLength(0);

      // THE PLACEMENT ASSERTION. A guard written after the `try` — or after the
      // INSERT — would refuse the same value and pass the same "no row" check
      // while leaving the plaintext seed live for the whole unwind. The length
      // check keeps it from passing vacuously on a null or empty retention.
      expect(emptyResultSealer.retainedSeed?.length).toBe(32);
      expect(Array.from(emptyResultSealer.retainedSeed ?? [1]).every((byte) => byte === 0)).toBe(
        true,
      );

      // THE ASSERTION THAT MAPS TO THE FINDING. The harm was never the bad blob
      // itself — it was that persisting one is terminal: the roster would hold a
      // public key whose private half is lost, and no `create` could ever
      // replace the row. Recovery is therefore the property under test, and it
      // is asserted end to end rather than as a resolved promise.
      const workingSource: DaemonSigningKeySource = new OsKeystoreSealedDaemonSigningKeySource(
        database,
        sealer,
        { now: () => FIXTURE_CREATED_AT },
      );
      const retried = await workingSource.create(SESSION_ONE);
      expect(ed25519.getPublicKey(await workingSource.read(SESSION_ONE))).toEqual(
        retried.publicKey,
      );
    });

    it("refuses a seal result that is not bytes at all, before Buffer.from coerces it", async () => {
      // The stub shape CP-006-11 contemplates in the interim: a sealer that
      // hands back its envelope as a STRING. Nothing in the type system stops
      // it — `seal` crosses an injection boundary this package neither owns nor
      // imports.
      const stringResult = "fake-seal:v1:not-actually-bytes";
      const stringResultSealer = new FixedSealResultSealer(stringResult);
      const source: DaemonSigningKeySource = new OsKeystoreSealedDaemonSigningKeySource(
        database,
        stringResultSealer,
        { now: () => FIXTURE_CREATED_AT },
      );

      // THE VACUITY CONTROL, AND THE REASON THE GUARD RUNS AHEAD OF THE BIND
      // RATHER THAN RELYING ON IT. `Buffer.from` COERCES this value into a
      // perfectly well-formed non-empty BLOB — one that satisfies NOT NULL and
      // every length check downstream — so unguarded this persists as a
      // healthy-looking row holding an envelope no `unseal` can ever open.
      // Nothing about the database would have caught it.
      expect(Buffer.from(stringResult).length).toBeGreaterThan(0);

      await expect(source.create(SESSION_ONE)).rejects.toThrow(
        /DaemonSigningKeySealer\.seal must return a non-empty Uint8Array for daemon_signing_keys\.sealed_private_key; received a non-Uint8Array value of type string\./,
      );

      expect(readSigningKeyRows(database)).toHaveLength(0);
      expect(stringResultSealer.retainedSeed?.length).toBe(32);
      expect(Array.from(stringResultSealer.retainedSeed ?? [1]).every((byte) => byte === 0)).toBe(
        true,
      );
    });

    it("refuses a sealer that echoes the seed back in cleartext", async () => {
      // THE WORSE HARM AT THE SAME SEAM. The two cases above strand a session;
      // this one is a key-custody breach — the Ed25519 secret seed persisted to
      // `sealed_private_key` in the clear, under a column every reader of the
      // table treats as sealed.
      const echoingSealer = new CleartextEchoingSealer();
      const source: DaemonSigningKeySource = new OsKeystoreSealedDaemonSigningKeySource(
        database,
        echoingSealer,
        { now: () => FIXTURE_CREATED_AT },
      );

      // THE VACUITY CONTROL, on a throwaway instance so it does not disturb the
      // scrub assertion below. The echoed blob clears every earlier guard —
      // non-empty, `Uint8Array`, 32 bytes — so the refusal is this check's and
      // nothing else's.
      const echoProbe: Uint8Array = await new CleartextEchoingSealer().seal(
        SESSION_ONE,
        new Uint8Array(32).fill(7),
      );
      expect(echoProbe).toBeInstanceOf(Uint8Array);
      expect(echoProbe.length).toBe(32);

      await expect(source.create(SESSION_ONE)).rejects.toThrow(
        /DaemonSigningKeySealer\.seal returned the private key unchanged .* would persist the Ed25519 secret seed in cleartext/,
      );

      expect(readSigningKeyRows(database)).toHaveLength(0);
      expect(echoingSealer.retainedSeed?.length).toBe(32);
      expect(Array.from(echoingSealer.retainedSeed ?? [1]).every((byte) => byte === 0)).toBe(true);
    });
  });

  // ========================================================================
  // Exactly once per session — the PRIMARY KEY guard.
  // ========================================================================

  describe("create is exactly once per session", () => {
    it("rejects a second create for the same session rather than re-keying", async () => {
      const first = await keySource.create(SESSION_ONE);

      let observedError: unknown;
      try {
        await keySource.create(SESSION_ONE);
      } catch (error) {
        observedError = error;
      }

      expect(observedError).toBeInstanceOf(Error);
      // Plain INSERT, never INSERT OR REPLACE / ON CONFLICT: SQLite adjudicates
      // the collision atomically, so there is no read-then-write window for a
      // concurrent second create to slip through.
      expect((observedError as { code?: string }).code).toBe("SQLITE_CONSTRAINT_PRIMARYKEY");
      expect((observedError as Error).message).toMatch(
        /UNIQUE constraint failed: daemon_signing_keys\.session_id/i,
      );

      // THE ASSERTION THAT MATTERS. The FIRST key survives, so every
      // `daemon_signature` already minted under it still verifies against the
      // public key the roster holds. A silent re-key would leave an untampered
      // log that fails forever — the failure this guard exists to prevent, and
      // the one a bare "it throws" assertion would not distinguish from a
      // rejected-then-replaced row.
      const rows = readSigningKeyRows(database);
      expect(rows).toHaveLength(1);
      const survivingSeed: Uint8Array = openFakeEnvelope(
        SESSION_ONE,
        Uint8Array.from(rows[0]?.sealed_private_key as Uint8Array),
      );
      expect(ed25519.getPublicKey(survivingSeed)).toEqual(first.publicKey);
      expect(await keySource.read(SESSION_ONE)).toEqual(survivingSeed);
    });

    it("admits a create for a different session, with independent key material", async () => {
      // Negative control for the collision above: the guard is scoped to one
      // session, so the store is genuinely per-session. Distinct keys also rule
      // out a shared-keypair regression that the single-session tests cannot
      // see.
      const first = await keySource.create(SESSION_ONE);
      const second = await keySource.create(SESSION_TWO);

      expect(readSigningKeyRows(database)).toHaveLength(2);
      expect(bytesToHex(second.publicKey)).not.toBe(bytesToHex(first.publicKey));
      expect(bytesToHex(await keySource.read(SESSION_TWO))).not.toBe(
        bytesToHex(await keySource.read(SESSION_ONE)),
      );
    });
  });

  // ========================================================================
  // read — the only path to private material.
  // ========================================================================

  describe("read is the only path to the private half", () => {
    it("resolves the unsealed seed for the public key create returned", async () => {
      const { publicKey } = await keySource.create(SESSION_ONE);

      const privateKey: Ed25519PrivateKey = await keySource.read(SESSION_ONE);

      expect(privateKey).toBeInstanceOf(Uint8Array);
      expect(privateKey.length).toBe(32);
      // The custody round trip, end to end: the key that comes back out derives
      // the key that went in.
      expect(ed25519.getPublicKey(privateKey)).toEqual(publicKey);
      // Unsealed on the way out, with the session id supplied on this side too.
      expect(sealer.unsealCalls).toHaveLength(1);
      expect(sealer.unsealCalls[0]?.sessionId).toBe(SESSION_ONE);
    });

    it("yields a key that signs a row the create-time public key verifies", async () => {
      // The reason the module exists, exercised through the actual signer rather
      // than asserted about byte equality: custody is correct only if the key it
      // resolves produces signatures the roster-registered public key accepts.
      const { publicKey } = await keySource.create(SESSION_ONE);
      const privateKey: Ed25519PrivateKey = await keySource.read(SESSION_ONE);

      const canonical: CanonicalBytes = canonicalizeJson({
        category: "audit_integrity",
        type: "audit.chain_verified",
      });
      const signed: SignedRow = signRow(canonical, GENESIS_PREV_HASH, privateKey);

      // No cast on `publicKey` — `create` resolves to
      // `{ publicKey: Ed25519PublicKey }` already, and a brand assertion
      // written where none is needed teaches the next reader that crossing
      // this boundary by cast is routine, which is how a real one gets in.
      // `toStrictEqual` and not `toEqual`, because `RowVerification` is a
      // discriminated union whose valid arm carries `valid` and nothing else:
      // `toEqual` ignores explicitly-`undefined` members, so it would also
      // accept a `{ valid: true, failureMode: undefined }` the union forbids.
      expect(verifyRow(canonical, signed, publicKey)).toStrictEqual({ valid: true });
    });

    it("copies the unsealed bytes, so a sealer reusing its buffer cannot corrupt a live key", async () => {
      // THE FAILURE THIS PREVENTS IS SILENT AND INDISTINGUISHABLE FROM TAMPERING.
      // Branded in place, the value `read` hands back IS the sealer's scratch
      // array; the next `unseal` overwrites it under a key the append path is
      // still holding across an `await`, `ed25519.sign` signs with a different
      // scalar, and the row carries a `daemon_signature` no roster-registered
      // public key verifies. At the verifier that is bit-for-bit the same
      // observation as a forged row — an untampered log reported as tampered,
      // with nothing in the record naming the cause.
      const scratchSealer = new ScratchBufferReusingSealer();
      const source: DaemonSigningKeySource = new OsKeystoreSealedDaemonSigningKeySource(
        database,
        scratchSealer,
        { now: () => FIXTURE_CREATED_AT },
      );
      const sessionOneCreated = await source.create(SESSION_ONE);
      await source.create(SESSION_TWO);

      const sessionOneKey: Ed25519PrivateKey = await source.read(SESSION_ONE);
      // IDENTITY, not content — content equality holds either way at this
      // point, so this is the only assertion that proves a copy happened.
      expect(sessionOneKey).not.toBe(scratchSealer.scratch);

      // The second unseal writes straight through the sealer's buffer...
      const sessionTwoKey: Ed25519PrivateKey = await source.read(SESSION_TWO);
      expect(sessionTwoKey).not.toBe(scratchSealer.scratch);
      expect(bytesToHex(sessionTwoKey)).not.toBe(bytesToHex(sessionOneKey));
      // ...which the sealer's own state confirms, so the overwrite genuinely
      // happened and the case is not vacuous.
      expect(bytesToHex(scratchSealer.scratch)).toBe(bytesToHex(sessionTwoKey));

      // ...and session one's key is untouched by it, still signing rows its own
      // create-time public key verifies. This is the property; the byte
      // comparison above could hold coincidentally, a valid signature cannot.
      const canonical: CanonicalBytes = canonicalizeJson({
        category: "audit_integrity",
        type: "audit.chain_verified",
      });
      const signed: SignedRow = signRow(canonical, GENESIS_PREV_HASH, sessionOneKey);
      expect(verifyRow(canonical, signed, sessionOneCreated.publicKey)).toStrictEqual({
        valid: true,
      });
    });

    it("refuses a session with no row, and does NOT mint one behind the read", async () => {
      await expect(keySource.read(SESSION_ONE)).rejects.toThrow(
        new RegExp(`No daemon signing key for session ${SESSION_ONE}`),
      );
      // Create-on-read is the silent version of the re-key failure above: a
      // second keypair minted behind a read would sign rows no roster-registered
      // public key verifies.
      expect(readSigningKeyRows(database)).toHaveLength(0);
      expect(sealer.sealCalls).toHaveLength(0);
    });

    it("refuses a stored value that is not a BLOB", async () => {
      await keySource.create(SESSION_ONE);
      // SQLite's BLOB declared type gives BLOB AFFINITY with no coercion, so
      // anything with write access to the file can leave TEXT in the column and
      // better-sqlite3 hands it back as a JS string. Unguarded it reaches the
      // sealer as a non-`Uint8Array` and surfaces as whatever that
      // implementation throws, far from the column that caused it.
      database
        .prepare("UPDATE daemon_signing_keys SET sealed_private_key = ? WHERE session_id = ?")
        .run("not-actually-bytes", SESSION_ONE);

      await expect(keySource.read(SESSION_ONE)).rejects.toThrow(
        /sealed_private_key for session .* is not a non-empty BLOB: got a non-Uint8Array value of type string/,
      );
      // Refused BEFORE the sealer is consulted — that is what keeps the
      // diagnostic naming the column.
      expect(sealer.unsealCalls).toHaveLength(0);
    });

    it("refuses a stored zero-length blob, which NOT NULL does not", async () => {
      // THE ROWS THE WRITE-SIDE GUARD CANNOT REACH. `create` now refuses an
      // empty seal result before the INSERT, but that says nothing about rows
      // already on disk — one written by a build predating the guard, or a
      // column truncated at rest. This is the read-side half, and it is a
      // genuinely distinct case from the one above: a zero-length blob IS a
      // `Uint8Array`, so byte-ness alone waves it through.
      await keySource.create(SESSION_ONE);
      database
        .prepare("UPDATE daemon_signing_keys SET sealed_private_key = ? WHERE session_id = ?")
        .run(Buffer.alloc(0), SESSION_ONE);

      // THE VACUITY CONTROL. `BLOB NOT NULL` refuses NULL and nothing else, so
      // the write above genuinely succeeded and the row genuinely came back as
      // zero bytes — without this the test could be passing against a database
      // that had rejected the UPDATE.
      const storedBlob: unknown = readSigningKeyRows(database)[0]?.sealed_private_key;
      expect(storedBlob).toBeInstanceOf(Uint8Array);
      expect((storedBlob as Uint8Array).length).toBe(0);

      await expect(keySource.read(SESSION_ONE)).rejects.toThrow(
        /sealed_private_key for session .* is not a non-empty BLOB: got 0 bytes/,
      );
      // Refused before the keystore is touched, like both sibling column
      // guards: an empty envelope cannot open, so prompting for the WebAuthn
      // ceremony `Spec-022 §Daemon Master Key` permits after an idle wipe would
      // buy a refusal either way.
      expect(sealer.unsealCalls).toHaveLength(0);
    });

    it("refuses an unsealed key of the wrong width (the RFC 8032 §5.1.5 guard)", async () => {
      // The realistic shape of this bug at the injected boundary: a truncating
      // envelope, an off-by-one slice, or a blob sealed under some other format.
      // Unchecked it would be laundered into `Ed25519PrivateKey` and only refused
      // later by `ed25519.sign`, whose throw names the signer rather than the
      // unseal that produced it.
      const truncatingSource: DaemonSigningKeySource = new OsKeystoreSealedDaemonSigningKeySource(
        database,
        new FixedUnsealResultSealer(new Uint8Array(31)),
        { now: () => FIXTURE_CREATED_AT },
      );
      await truncatingSource.create(SESSION_ONE);

      await expect(truncatingSource.read(SESSION_ONE)).rejects.toThrow(
        /Ed25519 private key must be 32 bytes per RFC 8032 §5\.1\.5; received 31 bytes\./,
      );
    });

    it("refuses an unsealed value that is not bytes at all", async () => {
      const nonByteSource: DaemonSigningKeySource = new OsKeystoreSealedDaemonSigningKeySource(
        database,
        new FixedUnsealResultSealer("9d61b19deffd5a60ba844af492ec2cc4"),
        { now: () => FIXTURE_CREATED_AT },
      );
      await nonByteSource.create(SESSION_ONE);

      // `describeByteShape` refuses to read `.length` off a string — a character
      // count reported as a byte count sends the reader after the wrong bug.
      await expect(nonByteSource.read(SESSION_ONE)).rejects.toThrow(
        /Ed25519 private key must be 32 bytes per RFC 8032 §5\.1\.5; received a non-Uint8Array value of type string\./,
      );
    });

    it("cannot be used to unseal another session's key material", async () => {
      // The property the `sessionId` parameter on BOTH sealer methods exists to
      // make available: with the binding, a `sealed_private_key` blob copied
      // from one row to another fails to unseal instead of silently
      // authenticating the wrong session's rows. The module cannot enforce the
      // BINDING (it fixes no format), so what is pinned here is that it PASSES
      // the session id on the read side — a sealer that binds is given what it
      // needs. The next test covers the sealer that declines to use it, where
      // the refusal has to come from the row instead.
      await keySource.create(SESSION_ONE);
      await keySource.create(SESSION_TWO);
      const rows = readSigningKeyRows(database);
      const sessionOneRow = rows.find((row) => row.session_id === SESSION_ONE);
      expect(sessionOneRow).toBeDefined();

      database
        .prepare("UPDATE daemon_signing_keys SET sealed_private_key = ? WHERE session_id = ?")
        .run(Buffer.from(sessionOneRow?.sealed_private_key as Uint8Array), SESSION_TWO);

      await expect(keySource.read(SESSION_TWO)).rejects.toThrow(
        new RegExp(`envelope is not bound to session ${SESSION_TWO}`),
      );
    });
  });

  // ========================================================================
  // The unsealed seed belongs to the row it came out of.
  // ========================================================================
  //
  // The one check in this module that does not take the injected boundary's
  // word for anything: `create` wrote `public_key` and `sealed_private_key`
  // from a single `ed25519.keygen()` result into a single row, so the row
  // carries its own refutation of a substituted key.
  //
  // The first two cases hand `read` a 32-byte, well-formed, genuinely usable
  // Ed25519 seed — every shape guard in the module passes it, and the
  // derivation check is the only thing that refuses. The last two corrupt the
  // `public_key` column that derivation is compared AGAINST, and are refused
  // earlier and by a different guard; each pins a distinct reason that guard
  // exists.

  describe("read refuses a key that is not this row's", () => {
    it("refuses a correctly-sized seed from a different keypair", async () => {
      // Sourced from `ed25519.keygen()` rather than from arbitrary bytes so the
      // refusal cannot be attributed to `getPublicKey` choking on an invalid
      // seed: this value is a real secret key that derives a real public key,
      // just not this row's.
      const foreignKeyPair = ed25519.keygen();
      const foreignSeed: Uint8Array = Uint8Array.from(foreignKeyPair.secretKey);
      expect(foreignSeed.length).toBe(32);

      const substitutingSource: DaemonSigningKeySource = new OsKeystoreSealedDaemonSigningKeySource(
        database,
        new FixedUnsealResultSealer(foreignSeed),
        { now: () => FIXTURE_CREATED_AT },
      );
      const created = await substitutingSource.create(SESSION_ONE);

      await expect(substitutingSource.read(SESSION_ONE)).rejects.toThrow(
        /sealed_private_key for session .* unsealed to a key whose public half is not this row's public_key/,
      );

      // WHAT THE REFUSAL STANDS BETWEEN THE CALLER AND, spelled with the real
      // verifier rather than asserted. Had the key escaped, the append path
      // would have signed with it, and the row would come back from
      // `verifyRow` as `signature_mismatch` — the possible-tampering verdict
      // that warrants incident response — against the very public key `create`
      // handed the roster registrar. The brand cast is the point rather than
      // a shortcut: the mint site now refuses this seed, so there is no
      // sanctioned way to obtain a branded key that does not match its row.
      const canonical: CanonicalBytes = canonicalizeJson({
        category: "audit_integrity",
        type: "audit.chain_verified",
      });
      const signedWithForeignKey: SignedRow = signRow(
        canonical,
        GENESIS_PREV_HASH,
        foreignSeed as Ed25519PrivateKey,
      );
      expect(verifyRow(canonical, signedWithForeignKey, created.publicKey)).toStrictEqual({
        valid: false,
        failureMode: "signature_mismatch",
      });
    });

    it("refuses a blob copied from another row when the sealer does not bind the session id", async () => {
      // THE REACHABLE SHAPE OF THE SUBSTITUTION, END TO END. The sealer here
      // satisfies `DaemonSigningKeySealer` while ignoring `sessionId`, which
      // that interface explicitly permits; an at-rest edit then copies session
      // one's sealed blob onto session two's row. Both halves are things the
      // module has no say over — the injected implementation, and write access
      // to the database file it already guards against elsewhere.
      const unboundSealer = new SessionIdIgnoringFakeSealer();
      const source: DaemonSigningKeySource = new OsKeystoreSealedDaemonSigningKeySource(
        database,
        unboundSealer,
        { now: () => FIXTURE_CREATED_AT },
      );
      const sessionOneCreated = await source.create(SESSION_ONE);
      await source.create(SESSION_TWO);

      const sessionOneSealed: Uint8Array = Uint8Array.from(
        readSigningKeyRows(database).find((row) => row.session_id === SESSION_ONE)
          ?.sealed_private_key as Uint8Array,
      );
      database
        .prepare("UPDATE daemon_signing_keys SET sealed_private_key = ? WHERE session_id = ?")
        .run(Buffer.from(sessionOneSealed), SESSION_TWO);

      // THE VACUITY CONTROL. The sealer really does open the copied blob under
      // the wrong session id — so the refusal below is the module's, not a
      // fake that happened to fail. This is the same call `read` makes.
      const unsealedUnderSessionTwo: Uint8Array = await unboundSealer.unseal(
        SESSION_TWO,
        sessionOneSealed,
      );
      expect(ed25519.getPublicKey(unsealedUnderSessionTwo)).toEqual(sessionOneCreated.publicKey);

      await expect(source.read(SESSION_TWO)).rejects.toThrow(
        /sealed_private_key for session .* unsealed to a key whose public half is not this row's public_key/,
      );

      // And session one — whose row was not touched — still reads under the
      // same sealer, so the check refuses a substitution rather than refusing
      // everything an unbound sealer produces.
      expect(ed25519.getPublicKey(await source.read(SESSION_ONE))).toEqual(
        sessionOneCreated.publicKey,
      );
    });

    it("refuses a stored public key that is not bytes, before the sealer is consulted", async () => {
      await keySource.create(SESSION_ONE);
      // Same BLOB-affinity hole as the sibling column: SQLite coerces nothing,
      // so anything with write access can leave TEXT here. Unguarded it would
      // reach `equalBytes`, whose `abytes` raises a `TypeError` naming noble
      // instead of this row.
      database
        .prepare("UPDATE daemon_signing_keys SET public_key = ? WHERE session_id = ?")
        .run("not-actually-bytes", SESSION_ONE);

      await expect(keySource.read(SESSION_ONE)).rejects.toThrow(
        /daemon_signing_keys\.public_key for session .* is not a 32-byte BLOB: got a non-Uint8Array value of type string/,
      );
      // Both column guards run ahead of the unseal, so a malformed row costs no
      // keystore access — `Spec-022 §Daemon Master Key` permits the first unseal
      // after an idle wipe to block on a WebAuthn ceremony.
      expect(sealer.unsealCalls).toHaveLength(0);
    });

    it("refuses a truncated stored public key rather than reporting it as the wrong key", async () => {
      // WIDTH, NOT ONLY BYTE-NESS, AND THE DIAGNOSTIC IS THE REASON. A short
      // `public_key` does not throw at `equalBytes` — it compares unequal — so
      // without the width clause this row would be reported as a key that does
      // not match, sending the reader after a copied blob that was never there.
      const { publicKey } = await keySource.create(SESSION_ONE);
      database
        .prepare("UPDATE daemon_signing_keys SET public_key = ? WHERE session_id = ?")
        .run(Buffer.from(publicKey.subarray(0, 31)), SESSION_ONE);

      await expect(keySource.read(SESSION_ONE)).rejects.toThrow(
        /daemon_signing_keys\.public_key for session .* is not a 32-byte BLOB: got 31 bytes/,
      );
      expect(sealer.unsealCalls).toHaveLength(0);
    });
  });
});
