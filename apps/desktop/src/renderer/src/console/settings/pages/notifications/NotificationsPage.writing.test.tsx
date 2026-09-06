// What a notification switch sends, and what it will not send twice.
//
// The whole value written back with one member flipped, the re-read rather than a
// held edited copy, the refusal drawn on the row that asked for it, and the record
// locked while one of its switches is in flight. What the page READS is
// `NotificationsPage.reading.test.tsx`, over the one cast in
// `notifications-page.test-support.tsx`.
import type { ConsoleBridge } from "../../../bridge/index.js";
import { act } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { growthUnavailable } from "../../../bridge/index.js";
import type { AttentionPreference } from "./attention-preference-model.js";
import {
  PARTICIPANT_ID,
  SERVED_PARTICIPANT,
  bridgeWith,
  press,
  renderSettledPage,
  servedPreferences,
  storedRecordAt,
  storedSwitches,
  switchesIn,
} from "./notifications-page.test-support.js";

describe("the notifications page — what a switch sends", () => {
  /** Serves the identity and the set, and records every update the page attempts. */
  function bridgeRecordingUpdates(options: {
    readonly preferences: readonly AttentionPreference[];
    readonly updateOutcome:
      | { readonly status: "served"; readonly value: { readonly updatedAt: string } }
      | ReturnType<typeof growthUnavailable>;
  }): {
    readonly bridge: ConsoleBridge;
    readonly update: ReturnType<typeof vi.fn>;
    readonly read: ReturnType<typeof vi.fn>;
  } {
    const read = vi.fn(async () => await Promise.resolve(servedPreferences(options.preferences)));
    const update = vi.fn(async () => await Promise.resolve(options.updateOutcome));
    return {
      bridge: bridgeWith({
        callerParticipantRead: async () => await Promise.resolve(SERVED_PARTICIPANT),
        attentionPreferenceRead: read,
        attentionPreferenceUpdate: update,
      }),
      update,
      read,
    };
  }

  it("writes the whole value back with only the pressed member flipped", async () => {
    const recorded = bridgeRecordingUpdates({
      preferences: [{ key: "attention", value: { mentions: true, runs: false, digests: false } }],
      updateOutcome: { status: "served", value: { updatedAt: "2026-01-01T10:06:00.000Z" } },
    });
    const container = await renderSettledPage(recorded.bridge);
    await press(storedSwitches(container)[0]);
    expect(recorded.update).toHaveBeenCalledWith({
      participantId: PARTICIPANT_ID,
      key: "attention",
      value: { mentions: false, runs: false, digests: false },
    });
  });

  it("re-reads the set rather than holding its own edited copy", async () => {
    const recorded = bridgeRecordingUpdates({
      preferences: [{ key: "attention", value: { mentions: true } }],
      updateOutcome: { status: "served", value: { updatedAt: "2026-01-01T10:06:00.000Z" } },
    });
    const container = await renderSettledPage(recorded.bridge);
    expect(recorded.read).toHaveBeenCalledTimes(1);
    await press(storedSwitches(container)[0]);
    expect(recorded.read).toHaveBeenCalledTimes(2);
  });

  it("negative control: it shows no timestamp from the write as a second truth", async () => {
    const recorded = bridgeRecordingUpdates({
      preferences: [{ key: "attention", value: { mentions: true } }],
      updateOutcome: { status: "served", value: { updatedAt: "2026-01-01T10:06:00.000Z" } },
    });
    const container = await renderSettledPage(recorded.bridge);
    await press(storedSwitches(container)[0]);
    expect(container.textContent ?? "").not.toContain("2026-01-01T10:06:00.000Z");
  });

  it("renders a refused write on the row that asked for it", async () => {
    const refusal = growthUnavailable("attentionPreferenceUpdate");
    const recorded = bridgeRecordingUpdates({
      preferences: [{ key: "attention", value: { mentions: true } }],
      updateOutcome: refusal,
    });
    const container = await renderSettledPage(recorded.bridge);
    await press(storedSwitches(container)[0]);
    const row = container.querySelector(".meridian-attention-preferences__row");
    expect(row?.textContent).toContain(refusal.code);
    expect(row?.textContent).toContain(refusal.detail);
    // The set was not re-read: nothing was stored, so there is nothing new to read.
    expect(recorded.read).toHaveBeenCalledTimes(1);
  });

  it("stops the switch taking presses while its write is in flight", async () => {
    const held = bridgeHoldingItsWrite([{ key: "attention", value: { mentions: true } }]);
    const container = await renderSettledPage(held.bridge);
    await act(async () => {
      storedSwitches(container)[0]?.click();
      await Promise.resolve();
    });
    expect(storedSwitches(container)[0]?.hasAttribute("data-disabled")).toBe(true);
  });
});

/** Serves the identity and the set, and never answers the write it is given. */
function bridgeHoldingItsWrite(preferences: readonly AttentionPreference[]): {
  readonly bridge: ConsoleBridge;
  readonly update: ReturnType<typeof vi.fn>;
} {
  const update = vi.fn(async () => await new Promise<never>(() => undefined));
  return {
    bridge: bridgeWith({
      callerParticipantRead: async () => await Promise.resolve(SERVED_PARTICIPANT),
      attentionPreferenceRead: async () => await Promise.resolve(servedPreferences(preferences)),
      attentionPreferenceUpdate: update,
    }),
    update,
  };
}

describe("the notifications page — one write per record at a time", () => {
  const TWO_SWITCHES: readonly AttentionPreference[] = [
    { key: "attention", value: { mentions: true, runs: false } },
  ];

  it("locks the whole record while one of its switches is being written", async () => {
    const held = bridgeHoldingItsWrite(TWO_SWITCHES);
    const container = await renderSettledPage(held.bridge);
    await press(storedSwitches(container)[0]);

    const record = storedRecordAt(container, 0);
    expect(record.getAttribute("aria-busy")).toBe("true");
    expect(
      switchesIn(record).map((control) => control.hasAttribute("data-disabled")),
    ).toStrictEqual([true, true]);
  });

  it("negative control: the record's other switch cannot send a second whole-record write", async () => {
    // The finding itself. The update carries the WHOLE record, so a second write
    // composed while the first is still out is built from the same starting value and
    // undoes the member the first one flipped. Without the record-wide lock the
    // sibling switch is live and does exactly that.
    const held = bridgeHoldingItsWrite(TWO_SWITCHES);
    const container = await renderSettledPage(held.bridge);
    await press(storedSwitches(container)[0]);
    await press(storedSwitches(container)[1]);

    expect(held.update).toHaveBeenCalledTimes(1);
    expect(held.update).toHaveBeenCalledWith({
      participantId: PARTICIPANT_ID,
      key: "attention",
      value: { mentions: false, runs: false },
    });
  });

  it("negative control: a record nobody is writing keeps its switches", async () => {
    // Without this, a page that disabled every switch on the screen while any write
    // was out would satisfy the case above by locking preferences the write cannot
    // touch — the whole record is the scope, and nothing wider is.
    const held = bridgeHoldingItsWrite([
      ...TWO_SWITCHES,
      { key: "digest", value: { weekly: true } },
    ]);
    const container = await renderSettledPage(held.bridge);
    await press(storedSwitches(container)[0]);

    const untouched = storedRecordAt(container, 1);
    expect(untouched.getAttribute("aria-busy")).toBe("false");
    expect(
      switchesIn(untouched).map((control) => control.hasAttribute("data-disabled")),
    ).toStrictEqual([false]);
  });
});
