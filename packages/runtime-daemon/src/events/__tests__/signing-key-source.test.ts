// Daemon signing-key custody suite (Plan-006 T2.7 — `signing-key-source.ts`).
//
// WHY THIS FILE EXISTS. `signing-key-source.ts` is the one module in the
// workspace that holds daemon-private key material and the one site where key
// bytes enter the type system, and no Phase-2 task declared a suite for it. The
// three properties below are the ones that would fail silently and expensively:
//
//   1. THE PUBLIC/PRIVATE SPLIT IS A SECURITY BOUNDARY. `create` resolves to the
//      PUBLIC key and nothing else; the private half is reachable only through
//      the signer-local `read`. A regression that widened `create`'s result
//      would leak daemon-private material into Plan-002's session-create call
//      site (CP-006-7) — a boundary crossing the T2.7 row forbids outright, and
//      one no downstream test would notice.
//   2. THE SEAL IS AN INJECTED BOUNDARY, so a private key at rest is never
//      cleartext and a test never touches a real keystore. The fakes below are
//      what a headless CI box gets instead of Secret Service.
//   3. `create` IS EXACTLY ONCE PER SESSION, enforced by the `session_id`
//      PRIMARY KEY against a plain `INSERT` — never `INSERT OR REPLACE`. A
//      silent re-key is the worst outcome in the module: every
//      `daemon_signature` already written under the old key would verify
//      against nothing, producing an UNTAMPERED log that fails forever.
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
import type { Ed25519PrivateKey, Ed25519PublicKey, SignedRow } from "../signer.js";
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
      // `sealedPrivateKey` — is exactly the regression Plan-002's call site
      // could not detect, because it would simply receive more than it reads.
      expect(Object.keys(created)).toEqual(["publicKey"]);
      expect(created.publicKey).toBeInstanceOf(Uint8Array);
      expect(created.publicKey.length).toBe(32);
    });

    it("hands Plan-002 a public key that is genuinely this session's", async () => {
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

      // @ts-expect-error `read` is not on DaemonSigningKeyProvisioner — daemon-private signing material never crosses the Plan-006/Plan-002 boundary (CP-006-7)
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

      expect(verifyRow(canonical, signed, publicKey as Ed25519PublicKey)).toEqual({ valid: true });
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
        /sealed_private_key for session .* is not a BLOB: got a non-Uint8Array value of type string/,
      );
      // Refused BEFORE the sealer is consulted — that is what keeps the
      // diagnostic naming the column.
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
      // authenticating the wrong session's rows. The module cannot enforce this
      // (it fixes no format), so what is pinned here is that it PASSES the
      // session id on the read side — a sealer that binds is given what it needs.
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
});
