// Two records toggled at once, and the two loops that have to finish independently.
//
// `notification-preference-writer.test.ts` next door holds one record's serialisation
// — one write at a time, the queued flip composed against what the daemon stored.
// This file holds the other job, which only two records can show: writes are
// serialised per RECORD, so toggling two runs two loops at once, each taking its own
// whole-set re-read, and each has to unlock its own record whatever the other one did.
// That is a different failure with a different harness, which is why it is a different
// file.
//
// WHICH OF THOSE TWO RE-READS THE SECTION SHOWS IS NOT ASSERTED HERE. Two reads of one
// set supersede each other in `attention-preference-read.ts`, whoever asked for them —
// a writer's loop, a window focus, a reconnect — so the ordering rule is measured
// against that reading in its own file, and asserting it over a writer would be a
// second statement of one rule.

import { describe, expect, it } from "vitest";

import {
  projectPreferenceRows,
  type AttentionPreference,
  type AttentionPreferenceReadOutcome,
  type PreferenceToggleMember,
} from "./attention-preference-model.js";
import {
  drain,
  UPDATED_AT,
  writerFor,
  type AttentionPreferenceStore,
  type UpdateOutcome,
} from "./notification-preference-writer.test-support.js";
import type { TogglePreferenceRow } from "./notification-preference-writer.js";

/** Two records, so two of the writer's per-record loops can run at once. */
const TWO_RECORDS: readonly AttentionPreference[] = [
  { key: "attention", value: { mentions: true, runs: false } },
  { key: "delivery", value: { desktop: true } },
];

/**
 * A stored set whose writes AND whole-set reads are both settled by hand.
 *
 * The harness above settles writes and answers reads at once, which cannot express
 * the ordering under test: two loops each take a whole-set read at a different
 * moment and their replies arrive in the other order. Each held read captures the
 * stored set at the moment it was TAKEN, because that is what makes an older reply
 * genuinely older rather than merely later.
 */
function storeHoldingBothCalls(initial: readonly AttentionPreference[]): {
  readonly port: AttentionPreferenceStore;
  readonly acceptWrite: (recordKey: string) => void;
  readonly serveRead: (readIndex: number) => void;
  readonly readsTaken: () => number;
} {
  let preferences: readonly AttentionPreference[] = initial;
  const writeSettlersByKey = new Map<string, (outcome: UpdateOutcome) => void>();
  const lastValueByKey = new Map<string, Readonly<Record<string, unknown>>>();
  const heldReads: {
    readonly captured: readonly AttentionPreference[];
    readonly serve: (outcome: AttentionPreferenceReadOutcome) => void;
  }[] = [];
  return {
    port: {
      attentionPreferenceUpdate: (request) => {
        lastValueByKey.set(request.key, request.value);
        return new Promise<UpdateOutcome>((resolve) => {
          writeSettlersByKey.set(request.key, resolve);
        });
      },
      attentionPreferenceRead: () =>
        new Promise<AttentionPreferenceReadOutcome>((resolve) => {
          heldReads.push({ captured: preferences, serve: resolve });
        }),
    },
    acceptWrite: (recordKey) => {
      const written = lastValueByKey.get(recordKey);
      const settle = writeSettlersByKey.get(recordKey);
      if (written === undefined || settle === undefined) {
        throw new Error(`no write is in flight for ${recordKey}`);
      }
      preferences = preferences.map((preference) =>
        preference.key === recordKey ? { key: recordKey, value: written } : preference,
      );
      settle({ status: "served", value: { updatedAt: UPDATED_AT } });
    },
    serveRead: (readIndex) => {
      const held = heldReads[readIndex];
      if (held === undefined) {
        throw new Error(`read ${String(readIndex)} has not been taken`);
      }
      held.serve({ status: "served", value: { preferences: held.captured } });
    },
    readsTaken: () => heldReads.length,
  };
}

/** The record and one of its switches, projected rather than written out. */
function switchIn(
  preferences: readonly AttentionPreference[],
  recordKey: string,
): { readonly record: TogglePreferenceRow; readonly member: PreferenceToggleMember } {
  const record = projectPreferenceRows(preferences)
    .filter((row): row is TogglePreferenceRow => row.kind === "toggles")
    .find((row) => row.key === recordKey);
  const member = record?.members[0];
  if (record === undefined || member === undefined) {
    throw new Error(`the projection did not draw a switch for ${recordKey}`);
  }
  return { record, member };
}

describe("the preference writer — two records' loops run and finish independently", () => {
  it("hands each loop's own re-read on, and each is composed for its own record", async () => {
    const store = storeHoldingBothCalls(TWO_RECORDS);
    const published: AttentionPreferenceReadOutcome[] = [];
    const writer = writerFor(store.port, (outcome) => published.push(outcome));
    const attention = switchIn(TWO_RECORDS, "attention");
    const delivery = switchIn(TWO_RECORDS, "delivery");

    writer.toggle(attention.record, attention.member);
    store.acceptWrite("attention");
    await drain();
    expect(store.readsTaken()).toBe(1);

    writer.toggle(delivery.record, delivery.member);
    store.acceptWrite("delivery");
    await drain();
    expect(store.readsTaken()).toBe(2);

    // The newer read answers first, then the older one. Both reach the reading, which
    // is what decides between them; neither loop swallows the other's reply.
    store.serveRead(1);
    await drain();
    store.serveRead(0);
    await drain();

    expect(published).toHaveLength(2);
  });

  it("unlocks both records once both loops have settled", async () => {
    // A record that stays busy is every switch inside it dead for the window's life,
    // and the loop that unlocks it is the one whose re-read answered LAST — so a
    // writer that unlocked only on the newest reply would leave one record locked.
    const store = storeHoldingBothCalls(TWO_RECORDS);
    const writer = writerFor(store.port);
    const attention = switchIn(TWO_RECORDS, "attention");
    const delivery = switchIn(TWO_RECORDS, "delivery");

    writer.toggle(attention.record, attention.member);
    store.acceptWrite("attention");
    await drain();
    writer.toggle(delivery.record, delivery.member);
    store.acceptWrite("delivery");
    await drain();

    store.serveRead(1);
    await drain();
    store.serveRead(0);
    await drain();

    expect(writer.snapshot().busyRecordKeys.size).toBe(0);
  });

  it("negative control: a lone toggle still re-reads and unlocks", async () => {
    // Without this, both cases above would pass over a writer that had stopped
    // re-reading at all — which would freeze the section on its opening read.
    const store = storeHoldingBothCalls(TWO_RECORDS);
    const published: AttentionPreferenceReadOutcome[] = [];
    const writer = writerFor(store.port, (outcome) => published.push(outcome));
    const attention = switchIn(TWO_RECORDS, "attention");

    writer.toggle(attention.record, attention.member);
    store.acceptWrite("attention");
    await drain();
    store.serveRead(0);
    await drain();

    expect(published).toHaveLength(1);
    expect(writer.snapshot().busyRecordKeys.has("attention")).toBe(false);
  });
});
