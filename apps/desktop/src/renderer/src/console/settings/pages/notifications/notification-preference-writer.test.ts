// Two switches inside one record, and the write that must not undo the other.
//
// The case worth the most is the second toggle arriving while the first write is
// still out. Composed against the value on screen it sends a record with the first
// member's change reversed — a write that silently undoes a choice the person
// watched themselves make — and the only place that is visible is here, with the
// first write held open by hand.

import { describe, expect, it, vi } from "vitest";

import { growthUnavailable } from "../../../bridge/index.js";
import {
  projectPreferenceRows,
  type AttentionPreference,
  type PreferenceToggleMember,
} from "./attention-preference-model.js";
import {
  drain,
  UPDATED_AT,
  writerFor,
  type UpdateOutcome,
} from "./notification-preference-writer.test-support.js";
import {
  NotificationPreferenceWriter,
  type AttentionPreferencePort,
  type TogglePreferenceRow,
} from "./notification-preference-writer.js";

const TWO_SWITCHES: readonly AttentionPreference[] = [
  { key: "attention", value: { mentions: true, runs: false } },
];

/** One update as the writer sent it, so a case can read what was composed. */
interface RecordedUpdate {
  readonly participantId: string;
  readonly key: string;
  readonly value: Readonly<Record<string, unknown>>;
}

/**
 * A stored preference set whose writes are settled by hand.
 *
 * The store APPLIES an accepted write before answering the next read, which is what
 * makes the queued-toggle case meaningful: a writer composing against the record the
 * daemon now holds and one composing against the record on screen send different
 * bytes, and only a store that moved can tell them apart.
 */
function heldPreferenceStore(initial: readonly AttentionPreference[]): {
  readonly port: AttentionPreferencePort;
  readonly updates: readonly RecordedUpdate[];
  readonly acceptWrite: () => void;
  readonly refuseWrite: () => void;
  readonly refuseNextRead: () => void;
  readonly readCount: () => number;
  readonly stored: () => readonly AttentionPreference[];
} {
  let preferences: readonly AttentionPreference[] = initial;
  let settle: ((outcome: UpdateOutcome) => void) | undefined;
  let nextReadRefuses = false;
  let readCount = 0;
  const updates: RecordedUpdate[] = [];
  return {
    port: {
      attentionPreferenceUpdate: (request) => {
        updates.push(request);
        return new Promise<UpdateOutcome>((resolve) => {
          settle = resolve;
        });
      },
      attentionPreferenceRead: () => {
        readCount += 1;
        if (nextReadRefuses) {
          nextReadRefuses = false;
          return Promise.resolve(growthUnavailable("attentionPreferenceRead"));
        }
        return Promise.resolve({ status: "served", value: { preferences } });
      },
    },
    updates,
    acceptWrite: () => {
      const request = updates.at(-1);
      if (request === undefined) {
        throw new Error("no write is in flight");
      }
      preferences = preferences.map((preference) =>
        preference.key === request.key ? { key: preference.key, value: request.value } : preference,
      );
      settle?.({ status: "served", value: { updatedAt: UPDATED_AT } });
    },
    refuseWrite: () => {
      settle?.(growthUnavailable("attentionPreferenceUpdate"));
    },
    refuseNextRead: () => {
      nextReadRefuses = true;
    },
    readCount: () => readCount,
    stored: () => preferences,
  };
}

/**
 * The record these cases drive, and its two switches.
 *
 * Built by the real projection rather than written out, so no case invents a member
 * key or a value shape the page would never produce.
 */
function twoSwitchRecord(): {
  readonly record: TogglePreferenceRow;
  readonly mentions: PreferenceToggleMember;
  readonly runs: PreferenceToggleMember;
} {
  const [record] = projectPreferenceRows(TWO_SWITCHES).filter(
    (row): row is TogglePreferenceRow => row.kind === "toggles",
  );
  const mentions = record?.members[0];
  const runs = record?.members[1];
  if (record === undefined || mentions === undefined || runs === undefined) {
    throw new Error("the projection did not draw two switches");
  }
  return { record, mentions, runs };
}

describe("the preference writer — one write per record at a time", () => {
  it("holds the second toggle until the first write settles", async () => {
    const store = heldPreferenceStore(TWO_SWITCHES);
    const writer = writerFor(store.port);
    const { record, mentions, runs } = twoSwitchRecord();

    writer.toggle(record, mentions);
    writer.toggle(record, runs);
    await drain();

    // One write, not two: the second cannot be composed until the daemon has said
    // what it did with the first.
    expect(store.updates).toHaveLength(1);
    expect(store.updates[0]?.value).toStrictEqual({ mentions: false, runs: false });
    expect(writer.snapshot().busyRecordKeys.has(record.key)).toBe(true);
  });

  it("composes the queued toggle against the re-read record, keeping both flips", async () => {
    // The whole finding. Composed against the value on screen the second write sends
    // `{mentions: true, runs: true}` and the first member's change is gone.
    const store = heldPreferenceStore(TWO_SWITCHES);
    const writer = writerFor(store.port);
    const { record, mentions, runs } = twoSwitchRecord();

    writer.toggle(record, mentions);
    writer.toggle(record, runs);
    await drain();
    store.acceptWrite();
    await drain();

    expect(store.updates).toHaveLength(2);
    expect(store.updates[1]?.value).toStrictEqual({ mentions: false, runs: true });

    store.acceptWrite();
    await drain();

    expect(store.stored()).toStrictEqual([
      { key: "attention", value: { mentions: false, runs: true } },
    ]);
    expect(writer.snapshot().busyRecordKeys.has(record.key)).toBe(false);
  });

  it("re-reads once per served write and never twice for one", async () => {
    const store = heldPreferenceStore(TWO_SWITCHES);
    const writer = writerFor(store.port);
    const { record, mentions, runs } = twoSwitchRecord();

    writer.toggle(record, mentions);
    writer.toggle(record, runs);
    await drain();
    store.acceptWrite();
    await drain();
    store.acceptWrite();
    await drain();

    expect(store.readCount()).toBe(2);
  });

  it("hands each re-read to the page rather than holding its own copy", async () => {
    const onRecordsRead = vi.fn();
    const store = heldPreferenceStore(TWO_SWITCHES);
    const writer = writerFor(store.port, onRecordsRead);
    const { record, mentions } = twoSwitchRecord();

    writer.toggle(record, mentions);
    await drain();
    store.acceptWrite();
    await drain();

    expect(onRecordsRead).toHaveBeenCalledTimes(1);
    expect(onRecordsRead).toHaveBeenCalledWith({
      status: "served",
      value: { preferences: [{ key: "attention", value: { mentions: false, runs: false } }] },
    });
  });

  it("negative control: a record nobody is writing is not busy", async () => {
    // Without this, a writer that marked every record busy forever would satisfy the
    // serialisation cases above by never letting anything through at all.
    const store = heldPreferenceStore(TWO_SWITCHES);
    const writer = writerFor(store.port);
    const { record, mentions } = twoSwitchRecord();

    expect(writer.snapshot().busyRecordKeys.has(record.key)).toBe(false);
    writer.toggle(record, mentions);
    await drain();
    store.acceptWrite();
    await drain();

    expect(writer.snapshot().busyRecordKeys.has(record.key)).toBe(false);
  });
});

describe("the preference writer — a write the daemon refused", () => {
  it("leaves the queued toggle unsent and says why on both switches", async () => {
    const refusal = growthUnavailable("attentionPreferenceUpdate");
    const store = heldPreferenceStore(TWO_SWITCHES);
    const writer = writerFor(store.port);
    const { record, mentions, runs } = twoSwitchRecord();

    writer.toggle(record, mentions);
    writer.toggle(record, runs);
    await drain();
    store.refuseWrite();
    await drain();

    expect(store.updates).toHaveLength(1);
    // Nothing was stored, so there is nothing new to read.
    expect(store.readCount()).toBe(0);
    const refusals = writer.snapshot().refusalByMemberKey;
    expect(refusals.get(mentions.memberKey)?.detail).toBe(refusal.detail);
    // The toggle that never left says so too, rather than disappearing.
    expect(refusals.get(runs.memberKey)?.detail).toBe(refusal.detail);
    expect(writer.snapshot().busyRecordKeys.has(record.key)).toBe(false);
  });

  it("drops a queued toggle whose re-read refused, in the read's own words", async () => {
    const readRefusal = growthUnavailable("attentionPreferenceRead");
    const store = heldPreferenceStore(TWO_SWITCHES);
    const writer = writerFor(store.port);
    const { record, mentions, runs } = twoSwitchRecord();

    writer.toggle(record, mentions);
    writer.toggle(record, runs);
    await drain();
    store.refuseNextRead();
    store.acceptWrite();
    await drain();

    // Nothing is written against a value nobody read.
    expect(store.updates).toHaveLength(1);
    expect(writer.snapshot().refusalByMemberKey.get(runs.memberKey)?.detail).toBe(
      readRefusal.detail,
    );
  });

  it("unlocks the record when the port rejects instead of refusing", async () => {
    // The port answers a refusal rather than throwing, so this is the arm nobody is
    // supposed to reach. Without it a rejection leaves the record locked for the
    // window's life: every switch in it dead, with nothing on screen saying why.
    const writer = writerFor({
      attentionPreferenceUpdate: () => Promise.reject(new Error("the preference store is gone")),
      attentionPreferenceRead: () =>
        Promise.resolve({ status: "served", value: { preferences: [] } }),
    });
    const { record, mentions } = twoSwitchRecord();

    writer.toggle(record, mentions);
    await drain();

    expect(writer.snapshot().busyRecordKeys.has(record.key)).toBe(false);
    expect(writer.snapshot().refusalByMemberKey.get(mentions.memberKey)?.detail).toContain(
      "the preference store is gone",
    );
  });

  it("drops last time's reason when the same switch is pressed again", async () => {
    const store = heldPreferenceStore(TWO_SWITCHES);
    const writer = writerFor(store.port);
    const { record, mentions } = twoSwitchRecord();

    writer.toggle(record, mentions);
    await drain();
    store.refuseWrite();
    await drain();
    expect(writer.snapshot().refusalByMemberKey.has(mentions.memberKey)).toBe(true);

    writer.toggle(record, mentions);
    await drain();

    expect(writer.snapshot().refusalByMemberKey.has(mentions.memberKey)).toBe(false);
  });
});

describe("the preference writer — what it will not do", () => {
  it("writes nothing at all before an identity read has named a participant", async () => {
    const store = heldPreferenceStore(TWO_SWITCHES);
    const writer = new NotificationPreferenceWriter({
      port: store.port,
      participantId: undefined,
      onRecordsRead: () => undefined,
    });
    const { record, mentions } = twoSwitchRecord();

    writer.toggle(record, mentions);
    await drain();

    // A record written under a guessed participant puts one person's answers on
    // another person's screen; the writer fails closed rather than composing one.
    expect(store.updates).toHaveLength(0);
    expect(writer.snapshot().busyRecordKeys.size).toBe(0);
  });

  it("writes nothing from a released round, and stays usable afterwards", async () => {
    const store = heldPreferenceStore(TWO_SWITCHES);
    const writer = writerFor(store.port);
    const { record, mentions, runs } = twoSwitchRecord();

    writer.toggle(record, mentions);
    writer.toggle(record, runs);
    await drain();
    writer.releasePendingWrites();
    store.acceptWrite();
    await drain();

    // The queued toggle went with the round rather than landing on a page that has
    // moved on, and the writer is not dead — an effect cleanup runs between the two
    // invocations a strict mount makes of one effect.
    expect(store.updates).toHaveLength(1);
    expect(writer.snapshot().busyRecordKeys.size).toBe(0);

    writer.toggle(record, runs);
    await drain();

    expect(store.updates).toHaveLength(2);
  });
});
