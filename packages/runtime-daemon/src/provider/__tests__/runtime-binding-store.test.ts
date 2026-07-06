// RuntimeBindingStore — Plan-005 Phase 2 (T2.2).
//
// Exercises CRUD + the provider-output write-seam validation over a REAL Local
// SQLite handle via `openDatabase(":memory:")` — so BOTH the Zod write-seam
// layer AND the DB CHECK constraints from `0003-runtime-bindings.ts` fire
// end-to-end. A fresh private in-memory DB is opened per test (the full
// migration chain runs each time; the WAL pragma is a silent no-op on
// `:memory:`), so there is no tmp-file/unlink lifecycle to manage.
//
// Coverage map (cites are the authoritative contract, not just the ACs):
//   * Spec-005:55 (resume_handle is a provider-owned opaque handle, bounded at
//     the write seam): nullability round-trips; length-edge accept/reject;
//     whitespace-only + NUL rejection (the /\S/ + NUL hardening beyond the DB
//     CHECK).
//   * I-005-1 (driver authority remains local, daemon-resident binding store):
//     the store operates entirely over the local handle — every assertion below
//     reads/writes the local DB, with no provider round-trip.
//   * const↔Zod↔SQL-CHECK coherence: boundary fixtures are derived FROM the
//     exported consts and INSERTed through `create()` (a real INSERT), so a
//     const bumped above the SQL CHECK literal would pass Zod but fail the DB
//     CHECK — making this test fail. The coherence is enforced, not commented.
//
// Refs: Plan-005 §Phase 2 / T2.2, Spec-005 line 47, invariant I-005-1.

import type { Database as DatabaseType } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase } from "../../session/migration-runner.js";
import {
  CONTRACT_VERSION_MAX_LEN,
  ProviderOutputValidationError,
  RESUME_HANDLE_MAX_LEN,
} from "../provider-output-validation.js";
import { RuntimeBindingStore } from "../runtime-binding-store.js";

// ----------------------------------------------------------------------------
// Fixtures + per-test lifecycle
// ----------------------------------------------------------------------------

const RUN_ID: string = "run-01J0ND0000NN5J5J5J5J5J5J";
const OTHER_RUN_ID: string = "run-01J0ND0000NN5K5K5K5K5K5K";
const DRIVER_NAME: string = "claude";
const CONTRACT_VERSION: string = "1.2.3";

let db: DatabaseType;

beforeEach(() => {
  db = openDatabase(":memory:");
});

afterEach(() => {
  if (db.open) {
    db.close();
  }
});

// An ADVANCING clock: each call returns a distinct timestamp, so a "createdAt
// preserved while updatedAt bumped" assertion is non-vacuous (a constant clock
// could not distinguish the two timestamps).
function makeAdvancingClock(): () => string {
  let minute: number = 0;
  return () => {
    const stamp: string = `2026-06-02T12:${minute.toString().padStart(2, "0")}:00.000Z`;
    minute += 1;
    return stamp;
  };
}

// A collision-free deterministic id source.
function makeIdSource(): () => string {
  let counter: number = 0;
  return () => `binding-${(counter++).toString()}`;
}

function makeStore(now: () => string = makeAdvancingClock()): RuntimeBindingStore {
  return new RuntimeBindingStore(db, { now, newId: makeIdSource() });
}

// ----------------------------------------------------------------------------
// CRUD round-trips
// ----------------------------------------------------------------------------

describe("RuntimeBindingStore — CRUD round-trips", () => {
  it("create → findById round-trips every column", () => {
    const store = makeStore();
    const created = store.create({
      runId: RUN_ID,
      driverName: DRIVER_NAME,
      contractVersion: CONTRACT_VERSION,
      resumeHandle: "opaque-handle-abc",
      runtimeMetadata: { sessionRef: "s-1", nested: { count: 3 } },
    });

    expect(created.id).toBe("binding-0");
    expect(created.runId).toBe(RUN_ID);
    expect(created.driverName).toBe(DRIVER_NAME);
    expect(created.contractVersion).toBe(CONTRACT_VERSION);
    expect(created.resumeHandle).toBe("opaque-handle-abc");
    expect(created.runtimeMetadata).toEqual({ sessionRef: "s-1", nested: { count: 3 } });
    expect(created.createdAt).toBe(created.updatedAt);

    const found = store.findById(created.id);
    expect(found).toEqual(created);
  });

  it("findByRun returns ALL bindings for a run (1:many)", () => {
    const store = makeStore();
    const first = store.create({
      runId: RUN_ID,
      driverName: DRIVER_NAME,
      contractVersion: "1.0.0",
    });
    const second = store.create({
      runId: RUN_ID,
      driverName: "codex",
      contractVersion: "2.0.0",
    });
    // A binding on a DIFFERENT run must not appear.
    store.create({ runId: OTHER_RUN_ID, driverName: DRIVER_NAME, contractVersion: "1.0.0" });

    const forRun = store.findByRun(RUN_ID);
    expect(forRun).toHaveLength(2);
    expect(forRun.map((binding) => binding.id)).toEqual([first.id, second.id]);
  });

  it("findByRun returns [] when the run has no bindings", () => {
    const store = makeStore();
    expect(store.findByRun("run-with-nothing")).toEqual([]);
  });

  it("update mutates the patched fields, bumps updatedAt, preserves createdAt", () => {
    const store = makeStore();
    const created = store.create({
      runId: RUN_ID,
      driverName: DRIVER_NAME,
      contractVersion: "1.0.0",
      runtimeMetadata: { a: 1 },
    });

    const updated = store.update(created.id, {
      contractVersion: "1.1.0",
      runtimeMetadata: { a: 2, b: 3 },
    });

    expect(updated).toBeDefined();
    expect(updated?.contractVersion).toBe("1.1.0");
    expect(updated?.runtimeMetadata).toEqual({ a: 2, b: 3 });
    // Immutable columns unchanged.
    expect(updated?.id).toBe(created.id);
    expect(updated?.runId).toBe(created.runId);
    expect(updated?.driverName).toBe(created.driverName);
    expect(updated?.createdAt).toBe(created.createdAt);
    // updatedAt bumped past createdAt (advancing clock).
    expect(updated?.updatedAt).not.toBe(created.updatedAt);
    expect(updated?.updatedAt).not.toBe(updated?.createdAt);

    // The mutation is durable.
    expect(store.findById(created.id)).toEqual(updated);
  });

  it("update can clear resumeHandle to null (COALESCE-binding would silently no-op)", () => {
    const store = makeStore();
    const created = store.create({
      runId: RUN_ID,
      driverName: DRIVER_NAME,
      contractVersion: "1.0.0",
      resumeHandle: "present-handle",
    });

    const cleared = store.update(created.id, { resumeHandle: null });
    expect(cleared?.resumeHandle).toBeNull();
    expect(store.findById(created.id)?.resumeHandle).toBeNull();
  });

  it("update leaves absent patch keys untouched", () => {
    const store = makeStore();
    const created = store.create({
      runId: RUN_ID,
      driverName: DRIVER_NAME,
      contractVersion: "1.0.0",
      resumeHandle: "keep-me",
      runtimeMetadata: { keep: true },
    });

    const updated = store.update(created.id, { contractVersion: "1.0.1" });
    expect(updated?.contractVersion).toBe("1.0.1");
    expect(updated?.resumeHandle).toBe("keep-me");
    expect(updated?.runtimeMetadata).toEqual({ keep: true });
  });

  it("delete returns true then the row is gone; absent delete returns false", () => {
    const store = makeStore();
    const created = store.create({
      runId: RUN_ID,
      driverName: DRIVER_NAME,
      contractVersion: "1.0.0",
    });

    expect(store.delete(created.id)).toBe(true);
    expect(store.findById(created.id)).toBeUndefined();
    expect(store.delete(created.id)).toBe(false);
  });

  it("findById / update of an absent id behave (undefined)", () => {
    const store = makeStore();
    expect(store.findById("nope")).toBeUndefined();
    expect(store.update("nope", { contractVersion: "1.0.0" })).toBeUndefined();
  });
});

// ----------------------------------------------------------------------------
// Accept-edge pinning (symmetric — pin BOTH sides so a <=→< off-by-one cannot
// survive). Boundary fixtures are derived FROM the consts and round-trip through
// a real INSERT, enforcing const↔Zod↔SQL-CHECK coherence.
// ----------------------------------------------------------------------------

describe("RuntimeBindingStore — length boundary (const-derived, end-to-end)", () => {
  it("accepts a CONTRACT_VERSION_MAX_LEN-length canonical semver and round-trips it", () => {
    // A valid prerelease semver of exactly CONTRACT_VERSION_MAX_LEN chars:
    // "1.0.0-" (6) + (MAX - 6) prerelease-identifier chars.
    const maxVersion: string = "1.0.0-" + "a".repeat(CONTRACT_VERSION_MAX_LEN - 6);
    expect(maxVersion.length).toBe(CONTRACT_VERSION_MAX_LEN);

    const store = makeStore();
    const created = store.create({
      runId: RUN_ID,
      driverName: DRIVER_NAME,
      contractVersion: maxVersion,
    });
    expect(store.findById(created.id)?.contractVersion).toBe(maxVersion);
  });

  it("rejects a CONTRACT_VERSION_MAX_LEN+1-length contract_version", () => {
    const overVersion: string = "1.0.0-" + "a".repeat(CONTRACT_VERSION_MAX_LEN - 6 + 1);
    expect(overVersion.length).toBe(CONTRACT_VERSION_MAX_LEN + 1);

    const store = makeStore();
    expect(() =>
      store.create({ runId: RUN_ID, driverName: DRIVER_NAME, contractVersion: overVersion }),
    ).toThrow(ProviderOutputValidationError);
  });

  it("accepts a RESUME_HANDLE_MAX_LEN-length resume_handle and round-trips it", () => {
    const maxHandle: string = "h".repeat(RESUME_HANDLE_MAX_LEN);
    expect(maxHandle.length).toBe(RESUME_HANDLE_MAX_LEN);

    const store = makeStore();
    const created = store.create({
      runId: RUN_ID,
      driverName: DRIVER_NAME,
      contractVersion: CONTRACT_VERSION,
      resumeHandle: maxHandle,
    });
    expect(store.findById(created.id)?.resumeHandle).toBe(maxHandle);
  });

  it("rejects a RESUME_HANDLE_MAX_LEN+1-length resume_handle", () => {
    const overHandle: string = "h".repeat(RESUME_HANDLE_MAX_LEN + 1);
    const store = makeStore();
    expect(() =>
      store.create({
        runId: RUN_ID,
        driverName: DRIVER_NAME,
        contractVersion: CONTRACT_VERSION,
        resumeHandle: overHandle,
      }),
    ).toThrow(ProviderOutputValidationError);
  });
});

// ----------------------------------------------------------------------------
// Semver canonical-identity contract (pin the accept/reject sets exactly).
// ----------------------------------------------------------------------------

describe("RuntimeBindingStore — contract_version canonical-semver identity", () => {
  const accept: string[] = ["1.2.3", "1.0.0", "2.1.0-rc.1", "1.0.0-alpha.1"];
  const reject: string[] = ["1.0", "1", "01.2.3", "v1.2.3", " 1.2.3 ", "1.2.3+build.5", ""];

  for (const version of accept) {
    it(`accepts canonical semver ${JSON.stringify(version)}`, () => {
      const store = makeStore();
      const created = store.create({
        runId: RUN_ID,
        driverName: DRIVER_NAME,
        contractVersion: version,
      });
      expect(store.findById(created.id)?.contractVersion).toBe(version);
    });
  }

  for (const version of reject) {
    it(`rejects non-canonical / loose / malformed ${JSON.stringify(version)}`, () => {
      const store = makeStore();
      let thrown: unknown;
      try {
        store.create({ runId: RUN_ID, driverName: DRIVER_NAME, contractVersion: version });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(ProviderOutputValidationError);
      const validationError = thrown as ProviderOutputValidationError;
      expect(validationError.code).toBe("driver.provider_output_invalid");
      expect(validationError.fields?.["field"]).toBe("contract_version");
    });
  }
});

// ----------------------------------------------------------------------------
// resume_handle nullability + hardening.
// ----------------------------------------------------------------------------

describe("RuntimeBindingStore — resume_handle nullability + hardening", () => {
  it("omitted resumeHandle persists NULL and round-trips as null", () => {
    const store = makeStore();
    const created = store.create({
      runId: RUN_ID,
      driverName: DRIVER_NAME,
      contractVersion: CONTRACT_VERSION,
    });
    expect(created.resumeHandle).toBeNull();
    expect(store.findById(created.id)?.resumeHandle).toBeNull();
  });

  it("explicit null resumeHandle persists NULL", () => {
    const store = makeStore();
    const created = store.create({
      runId: RUN_ID,
      driverName: DRIVER_NAME,
      contractVersion: CONTRACT_VERSION,
      resumeHandle: null,
    });
    expect(store.findById(created.id)?.resumeHandle).toBeNull();
  });

  it("rejects a whitespace-only resume_handle (the /\\S/ hardening beyond the DB CHECK)", () => {
    const store = makeStore();
    let thrown: unknown;
    try {
      store.create({
        runId: RUN_ID,
        driverName: DRIVER_NAME,
        contractVersion: CONTRACT_VERSION,
        resumeHandle: "   ",
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ProviderOutputValidationError);
    expect((thrown as ProviderOutputValidationError).fields?.["field"]).toBe("resume_handle");
  });

  it("rejects a NUL-containing resume_handle", () => {
    const store = makeStore();
    expect(() =>
      store.create({
        runId: RUN_ID,
        driverName: DRIVER_NAME,
        contractVersion: CONTRACT_VERSION,
        resumeHandle: "before\0after",
      }),
    ).toThrow(ProviderOutputValidationError);
  });
});

// ----------------------------------------------------------------------------
// runtime_metadata round-trip.
// ----------------------------------------------------------------------------

describe("RuntimeBindingStore — runtime_metadata", () => {
  it("round-trips a non-trivial nested object", () => {
    const metadata = {
      provider: "anthropic",
      session: { id: "s-7", tokens: 1024 },
      flags: ["a", "b"],
      nested: { deep: { value: true } },
    };
    const store = makeStore();
    const created = store.create({
      runId: RUN_ID,
      driverName: DRIVER_NAME,
      contractVersion: CONTRACT_VERSION,
      runtimeMetadata: metadata,
    });
    expect(store.findById(created.id)?.runtimeMetadata).toEqual(metadata);
  });

  it("defaults omitted runtime_metadata to {}", () => {
    const store = makeStore();
    const created = store.create({
      runId: RUN_ID,
      driverName: DRIVER_NAME,
      contractVersion: CONTRACT_VERSION,
    });
    expect(created.runtimeMetadata).toEqual({});
    expect(store.findById(created.id)?.runtimeMetadata).toEqual({});
  });

  // FIX 5: create() must return the JSON-ROUND-TRIPPED metadata so it agrees with
  // findById() / update() (which reconstruct via JSON.parse). A value JSON
  // normalizes away — here `{ b: undefined }` — is the discriminator: pre-fix
  // create() returns the original object (key `b` PRESENT, value undefined),
  // findById() returns the round-tripped form (key `b` ABSENT), so they disagree.
  it("create() returns runtime_metadata round-tripped, matching findById() (DB-as-source-of-truth)", () => {
    const store = makeStore();
    const created = store.create({
      runId: RUN_ID,
      driverName: DRIVER_NAME,
      contractVersion: CONTRACT_VERSION,
      // `b: undefined` is dropped by JSON.stringify, so the persisted/round-tripped
      // form is `{ a: 1 }`. Pre-fix create() returned `{ a: 1, b: undefined }`.
      runtimeMetadata: { a: 1, b: undefined },
    });

    const found = store.findById(created.id);
    expect(found).toBeDefined();
    // `toStrictEqual` (NOT `toEqual`) — `toEqual` IGNORES undefined-valued keys, so
    // it would pass even pre-fix; `toStrictEqual` distinguishes a present
    // undefined-valued key from an absent one, which is what makes this fail-before.
    expect(created.runtimeMetadata).toStrictEqual(found?.runtimeMetadata);
    // And the round-tripped form is exactly `{ a: 1 }` (key `b` absent).
    expect(created.runtimeMetadata).toStrictEqual({ a: 1 });
    expect("b" in created.runtimeMetadata).toBe(false);
  });
});

// ----------------------------------------------------------------------------
// findResumableBindings (Plan-015 recovery seam — functional now).
// ----------------------------------------------------------------------------

describe("RuntimeBindingStore — findResumableBindings", () => {
  it("returns only bindings with a non-null resume_handle", () => {
    const store = makeStore();
    const withHandle = store.create({
      runId: RUN_ID,
      driverName: DRIVER_NAME,
      contractVersion: CONTRACT_VERSION,
      resumeHandle: "resumable-1",
    });
    // No handle → must NOT appear.
    store.create({ runId: RUN_ID, driverName: DRIVER_NAME, contractVersion: CONTRACT_VERSION });
    const otherWithHandle = store.create({
      runId: OTHER_RUN_ID,
      driverName: "codex",
      contractVersion: "2.0.0",
      resumeHandle: "resumable-2",
    });

    const resumable = store.findResumableBindings();
    expect(resumable.map((binding) => binding.id).sort()).toEqual(
      [withHandle.id, otherWithHandle.id].sort(),
    );
    expect(resumable.every((binding) => binding.resumeHandle !== null)).toBe(true);
  });

  it("returns [] when no binding carries a resume_handle", () => {
    const store = makeStore();
    store.create({ runId: RUN_ID, driverName: DRIVER_NAME, contractVersion: CONTRACT_VERSION });
    expect(store.findResumableBindings()).toEqual([]);
  });
});

// ----------------------------------------------------------------------------
// update revalidation (a rejected patch leaves the row unchanged).
// ----------------------------------------------------------------------------

describe("RuntimeBindingStore — update revalidation", () => {
  it("rejects an update to a non-canonical contract_version and leaves the row unchanged", () => {
    const store = makeStore();
    const created = store.create({
      runId: RUN_ID,
      driverName: DRIVER_NAME,
      contractVersion: "1.0.0",
      resumeHandle: "h",
    });

    expect(() => store.update(created.id, { contractVersion: "1.0" })).toThrow(
      ProviderOutputValidationError,
    );

    // Validation runs BEFORE the transaction, so the row is untouched.
    const after = store.findById(created.id);
    expect(after?.contractVersion).toBe("1.0.0");
    expect(after?.updatedAt).toBe(created.updatedAt);
  });

  it("rejects an update to an invalid resume_handle and leaves the row unchanged", () => {
    const store = makeStore();
    const created = store.create({
      runId: RUN_ID,
      driverName: DRIVER_NAME,
      contractVersion: "1.0.0",
      resumeHandle: "original",
    });

    expect(() => store.update(created.id, { resumeHandle: "   " })).toThrow(
      ProviderOutputValidationError,
    );

    const after = store.findById(created.id);
    expect(after?.resumeHandle).toBe("original");
    expect(after?.updatedAt).toBe(created.updatedAt);
  });

  it("validates the patch BEFORE the existence check: absent id + invalid patch THROWS", () => {
    // Precedence contract: the patch-shape asserts are an unconditional
    // precondition on the argument and run before the existence lookup. So an
    // invalid patch against a non-existent id THROWS (the patch is malformed
    // regardless of whether the target row exists — fail fast on the real caller
    // bug) rather than silently returning `undefined`. Contrast: an absent id
    // with a VALID patch returns `undefined` (pinned in the CRUD block).
    const store = makeStore();
    expect(() => store.update("absent-id", { contractVersion: "1.0" })).toThrow(
      ProviderOutputValidationError,
    );
  });
});
