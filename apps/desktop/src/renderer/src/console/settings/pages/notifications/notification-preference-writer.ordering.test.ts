// Two records toggled at once, and the whole-set re-read that must not go backwards.
//
// `notification-preference-writer.test.ts` next door holds one record's serialisation
// — one write at a time, the queued flip composed against what the daemon stored.
// This file holds the other job, which only two records can show: each record's loop
// re-reads the WHOLE set, so two loops overlap and their replies can land in the
// order they were not taken in. That is a different failure with a different harness,
// which is why it is a different file.

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
  type UpdateOutcome,
} from "./notification-preference-writer.test-support.js";
import type {
  AttentionPreferencePort,
  TogglePreferenceRow,
} from "./notification-preference-writer.js";

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
  readonly port: AttentionPreferencePort;
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

describe("the preference writer — the whole-set re-read is ordered across records", () => {
  it("keeps the newer snapshot when an older re-read answers behind it", async () => {
    // The defect: writes are serialised per RECORD, so toggling two records runs two
    // loops at once. Each re-reads the whole set, and the older read answering last
    // replaced the page with a snapshot taken before the second record's update — so
    // that accepted toggle looked reverted for the rest of the visit.
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

    // The newer read answers first, then the older one.
    store.serveRead(1);
    await drain();
    store.serveRead(0);
    await drain();

    expect(published).toHaveLength(1);
    const [onlyPublication] = published;
    expect(onlyPublication?.status).toBe("served");
    expect(
      onlyPublication?.status === "served" ? onlyPublication.value.preferences : undefined,
    ).toStrictEqual([
      { key: "attention", value: { mentions: false, runs: false } },
      { key: "delivery", value: { desktop: false } },
    ]);
  });

  it("negative control: a lone toggle still publishes its re-read", async () => {
    // Without this, the case above would pass over a writer that had stopped
    // publishing at all — which would freeze the page on its opening read.
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

  it("unlocks the record whose publication was discarded", async () => {
    // A discarded publication is not a discarded loop: the record still has to stop
    // being busy, or every switch inside it stays dead for the window's life.
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
});
