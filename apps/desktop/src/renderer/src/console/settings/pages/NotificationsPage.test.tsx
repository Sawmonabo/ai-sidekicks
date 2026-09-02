// The notifications page: the chain it reads, what it draws from an unnamed record,
// what a switch actually sends, and the tier it never offers.
//
// The two cases worth the most are the chain's refusal and the write's payload. A
// page that answered a refused identity read by asking the preference store anyway
// would have to guess a participant, which puts one person's answers on another
// person's screen; and a write that sent a fragment instead of the whole record
// would erase every member beside the one that was pressed.

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { growthUnavailable, type ConsoleBridge, type GrowthPort } from "../../bridge/index.js";
import {
  fixtureBridgeWithGrowth,
  unscriptedScenario,
} from "../../bridge/fixture-bridge-overrides.test-support.js";
import { LiveAnnouncerProvider } from "../../primitives/index.js";
import { NotificationsPage, registerNotificationsPage } from "./NotificationsPage.js";
import type {
  AttentionPreference,
  AttentionPreferenceReadOutcome,
  CallerParticipantOutcome,
} from "./attention-preference-model.js";
import { SettingsPageRegistry, type SettingsPageContext } from "../settings-page-registry.js";

const SESSION_ID = "session-notifications";
const PARTICIPANT_ID = "participant-ana";

afterEach(() => {
  cleanup();
});

/** A scenario that scripts nothing: the growth overrides are what these cases drive. */
const SCENARIO = unscriptedScenario("collaboration-notifications-test");

const SERVED_PARTICIPANT: CallerParticipantOutcome = {
  status: "served",
  value: { participantId: PARTICIPANT_ID },
};

/** The real fixture bridge, with only the operations a case drives overridden. */
function bridgeWith(growthOverrides: Partial<GrowthPort>): ConsoleBridge {
  return fixtureBridgeWithGrowth(SCENARIO, growthOverrides);
}

function servedPreferences(
  preferences: readonly AttentionPreference[],
): AttentionPreferenceReadOutcome {
  return { status: "served", value: { preferences } };
}

function contextWith(bridge: ConsoleBridge, activeSessionId: string | undefined) {
  return {
    bridge,
    openSection: () => undefined,
    activeSessionId,
  } satisfies SettingsPageContext;
}

/** Let the chained reads, the write, and the re-read all land. */
async function settle(): Promise<void> {
  for (let pass = 0; pass < 8; pass += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

/**
 * Mount at an address that names a session.
 *
 * The session id is not a default parameter: passing `undefined` to one would take
 * the default rather than the absence, which is precisely the case the
 * no-session test exists to drive. That test calls {@link renderPageAt} instead.
 */
async function renderSettledPage(bridge: ConsoleBridge): Promise<HTMLElement> {
  const container = renderPageAt(bridge, SESSION_ID);
  await settle();
  return container;
}

function renderPageAt(bridge: ConsoleBridge, activeSessionId: string | undefined): HTMLElement {
  const { container } = render(
    <LiveAnnouncerProvider>
      <NotificationsPage context={contextWith(bridge, activeSessionId)} />
    </LiveAnnouncerProvider>,
  );
  return container;
}

function politeAnnouncement(container: HTMLElement): string {
  return container.querySelector('[data-live-region="polite"]')?.textContent ?? "";
}

function storedSwitches(container: HTMLElement): HTMLElement[] {
  return [
    ...container.querySelectorAll<HTMLElement>(
      ".meridian-attention-preferences .meridian-settings-row__switch",
    ),
  ];
}

/** One rendered record, by position. Throws rather than casting an absent one. */
function storedRecordAt(container: HTMLElement, index: number): HTMLElement {
  const record = container.querySelectorAll<HTMLElement>(".meridian-attention-preferences__row")[
    index
  ];
  if (record === undefined) {
    throw new Error(`no stored preference record was rendered at position ${String(index)}`);
  }
  return record;
}

function switchesIn(record: HTMLElement): HTMLElement[] {
  return [...record.querySelectorAll<HTMLElement>(".meridian-settings-row__switch")];
}

function storedLabels(container: HTMLElement): string[] {
  return [
    ...container.querySelectorAll<HTMLElement>(
      ".meridian-attention-preferences .meridian-settings-row__label",
    ),
  ].map((element) => element.textContent ?? "");
}

async function press(element: HTMLElement | undefined): Promise<void> {
  await act(async () => {
    element?.click();
    await Promise.resolve();
  });
  await settle();
}

describe("the notifications page — the machine-local mute", () => {
  it("promises that in-app attention survives a muted desktop", async () => {
    const container = await renderSettledPage(bridgeWith({}));
    expect(container.textContent ?? "").toContain("Muting the desktop never mutes the console");
  });

  it("holds the mute in this window when no carrier takes it", async () => {
    const container = await renderSettledPage(bridgeWith({}));
    const control = container.querySelector<HTMLElement>(
      'section[aria-label="Operating system notifications"] .meridian-settings-row__switch',
    );
    await press(control ?? undefined);
    expect(container.textContent ?? "").toContain("Held in this window");
    expect(
      container
        .querySelector(
          'section[aria-label="Operating system notifications"] .meridian-settings-row__switch',
        )
        ?.getAttribute("aria-checked"),
    ).toBe("true");
  });
});

describe("the notifications page — the tier it never offers", () => {
  it("says the preferences are global with no per-session tier", async () => {
    const container = await renderSettledPage(bridgeWith({}));
    expect(container.textContent ?? "").toContain("no per-session tier");
  });

  it("negative control: no control anywhere is labelled with a session", async () => {
    // The section forbids implying a per-session preference exists, and the cheapest
    // way one would arrive is a control labelled with a session. Every rendered
    // control label is checked, including the ones the daemon's own keys supply.
    const container = await renderSettledPage(
      bridgeWith({
        callerParticipantRead: async () => await Promise.resolve(SERVED_PARTICIPANT),
        attentionPreferenceRead: async () =>
          await Promise.resolve(
            servedPreferences([{ key: "attention", value: { mentions: true, runs: false } }]),
          ),
      }),
    );
    const controlLabels = [
      ...container.querySelectorAll<HTMLElement>(".meridian-settings-row__label"),
    ].map((element) => element.textContent ?? "");
    expect(controlLabels.length).toBeGreaterThan(1);
    for (const label of controlLabels) {
      expect(label).not.toMatch(/session/iu);
    }
  });
});

describe("the notifications page — the chain that starts with who you are", () => {
  it("asks nothing when the address names no session to resolve an identity from", async () => {
    const identityRead = vi.fn(async () => await Promise.resolve(SERVED_PARTICIPANT));
    const container = renderPageAt(bridgeWith({ callerParticipantRead: identityRead }), undefined);
    await settle();
    expect(identityRead).not.toHaveBeenCalled();
    expect(container.textContent ?? "").toContain("have not been read yet");
    expect(container.querySelector(".meridian-nothing--not-checked")).not.toBeNull();
  });

  it("renders the identity read's own refusal in place of the set", async () => {
    const refusal = growthUnavailable("callerParticipantRead");
    const preferenceRead = vi.fn(async () => await Promise.resolve(servedPreferences([])));
    const container = await renderSettledPage(
      bridgeWith({
        callerParticipantRead: async () => await Promise.resolve(refusal),
        attentionPreferenceRead: preferenceRead,
      }),
    );
    expect(container.textContent ?? "").toContain(refusal.detail);
    expect(politeAnnouncement(container)).toBe(refusal.detail);
  });

  it("negative control: it never guesses a participant to ask with", async () => {
    // Without this, the case above would pass over a page that refused visibly and
    // still went on to read somebody's preferences — the one outcome that would put
    // another person's answers on this screen.
    const preferenceRead = vi.fn(async () => await Promise.resolve(servedPreferences([])));
    await renderSettledPage(
      bridgeWith({
        callerParticipantRead: async () =>
          await Promise.resolve(growthUnavailable("callerParticipantRead")),
        attentionPreferenceRead: preferenceRead,
      }),
    );
    expect(preferenceRead).not.toHaveBeenCalled();
  });

  it("reads the set for the participant the identity read named", async () => {
    const preferenceRead = vi.fn(async () => await Promise.resolve(servedPreferences([])));
    await renderSettledPage(
      bridgeWith({
        callerParticipantRead: async () => await Promise.resolve(SERVED_PARTICIPANT),
        attentionPreferenceRead: preferenceRead,
      }),
    );
    expect(preferenceRead).toHaveBeenCalledWith({ participantId: PARTICIPANT_ID });
  });
});

describe("the notifications page — what it draws from a record nobody named", () => {
  function bridgeServing(preferences: readonly AttentionPreference[]): ConsoleBridge {
    return bridgeWith({
      callerParticipantRead: async () => await Promise.resolve(SERVED_PARTICIPANT),
      attentionPreferenceRead: async () => await Promise.resolve(servedPreferences(preferences)),
    });
  }

  it("says the daemon holds nothing rather than drawing a default", async () => {
    const container = await renderSettledPage(bridgeServing([]));
    expect(container.textContent ?? "").toContain("holds no preference for you yet");
    expect(container.querySelector(".meridian-nothing--empty")).not.toBeNull();
    expect(storedSwitches(container)).toHaveLength(0);
  });

  it("draws one switch per member, labelled with the member's own name", async () => {
    const container = await renderSettledPage(
      bridgeServing([{ key: "attention", value: { mentions: true, runs: false } }]),
    );
    expect(container.textContent ?? "").toContain("attention");
    expect(storedLabels(container)).toStrictEqual(["mentions", "runs"]);
    expect(
      storedSwitches(container).map((control) => control.getAttribute("aria-checked")),
    ).toStrictEqual(["true", "false"]);
  });

  it("negative control: a value that is not all booleans is shown read-only", async () => {
    // Drawing switches for the boolean members of a mixed record would offer control
    // over a value the console cannot write back intact.
    const container = await renderSettledPage(
      bridgeServing([{ key: "digest", value: { every: "monday", runs: true } }]),
    );
    expect(storedSwitches(container)).toHaveLength(0);
    expect(container.querySelector(".meridian-attention-preferences__opaque")?.textContent).toBe(
      '{"every":"monday","runs":true}',
    );
  });

  it("announces the settlement once, politely, with what it read", async () => {
    const container = await renderSettledPage(
      bridgeServing([{ key: "attention", value: { mentions: true } }]),
    );
    expect(politeAnnouncement(container)).toBe(
      "Your notification preferences were read. Stored: 1.",
    );
  });
});

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

describe("the notifications page — its rail entry", () => {
  it("claims the notifications section with a search vocabulary", () => {
    const registry = new SettingsPageRegistry();
    registerNotificationsPage(registry);
    const descriptor = registry.descriptorFor("notifications");
    expect(descriptor?.label).toBe("Notifications");
    expect(descriptor?.keywords).toContain("mute");
  });

  it("names no governance work in any copy of its own", async () => {
    // Driven against SERVED reads on purpose. A refusal renders the port's own
    // sentence verbatim, and that sentence names the document that owes the wire —
    // which is the shipped refusal's text and not copy this page composed.
    const container = await renderSettledPage(
      bridgeWith({
        callerParticipantRead: async () => await Promise.resolve(SERVED_PARTICIPANT),
        attentionPreferenceRead: async () =>
          await Promise.resolve(
            servedPreferences([{ key: "attention", value: { mentions: true } }]),
          ),
      }),
    );
    expect(container.textContent ?? "").not.toMatch(/\b(?:Spec|Plan|ADR|BL|CP|I)-\d/u);
  });
});
