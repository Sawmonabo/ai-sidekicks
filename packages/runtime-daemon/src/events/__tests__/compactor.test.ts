// The compactor never sweeps content keys from inside an append-lock hold, where it would acquire
// nothing for the held session.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SessionIdSchema, type SessionId } from "@ai-sidekicks/contracts";

import { Compactor } from "../compactor.js";
import { __resetSessionAppendLocksForTest, withSessionAppendLock } from "../session-append-lock.js";
import type {
  SessionContentKeyDisposer,
  SessionContentKeySweepResult,
} from "../session-content-key-store.js";

const HELD_SESSION: SessionId = SessionIdSchema.parse("11111111-2222-4333-8444-555555555555");

beforeEach(() => {
  __resetSessionAppendLocksForTest();
});

afterEach(() => {
  __resetSessionAppendLocksForTest();
});

/** Counts sweeps; the store's own predicate is tested against a real table elsewhere. */
class RecordingContentKeyDisposer implements SessionContentKeyDisposer {
  sweeps = 0;

  async deleteIfUnreferenced(): Promise<boolean> {
    throw new Error("the compactor never disposes one session's key");
  }

  async sweepUnreferenced(): Promise<SessionContentKeySweepResult> {
    this.sweeps += 1;
    return { reclaimed: 0, skipped: 0 };
  }
}

describe("Compactor — the tick's guards", () => {
  it("does nothing when entered inside an append-lock hold", async () => {
    // The sweep takes each session's append lock, and the lock is reentrant per owner, so a
    // sweep inside a hold would acquire nothing for that session.
    const disposer = new RecordingContentKeyDisposer();
    const compactor = new Compactor({ contentKeyDisposer: disposer });

    const insideHold = await withSessionAppendLock(HELD_SESSION, () => compactor.tick());
    expect(insideHold).toEqual({ contentKeysReclaimed: 0, contentKeysSkipped: 0 });
    expect(disposer.sweeps).toBe(0);

    // The same instance sweeps once outside the hold.
    await compactor.tick();
    expect(disposer.sweeps).toBe(1);
  });
});
