// What the notifications page reads, and what it draws from it.
//
// The machine-local mute, the per-session tier it never offers, the chain that starts
// with the identity read, and the record it draws one switch per member from. What a
// switch SENDS is `NotificationsPage.writing.test.tsx`, over the one cast in
// `notifications-page.test-support.tsx`.
import type { ConsoleBridge } from "../../../bridge/index.js";
import { act } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ATTENTION_TRIGGERS, growthUnavailable } from "../../../bridge/index.js";
import { politeText } from "../../../primitives/live-region.test-support.js";
import { registerNotificationsPage } from "./NotificationsPage.js";
import type { AttentionPreference } from "./attention-preference-model.js";
import { SettingsPageRegistry } from "../../settings-page-registry.js";
import {
  PARTICIPANT_ID,
  SERVED_PARTICIPANT,
  bridgeWith,
  press,
  renderPageAt,
  renderSettledPage,
  servedPreferences,
  settle,
  storedLabels,
  storedSwitches,
} from "./notifications-page.test-support.js";

/** Every row this console supplied rather than read, as the page tags them. */
function defaultTags(container: HTMLElement): readonly Element[] {
  return [...container.querySelectorAll(".meridian-attention-preferences__key .meridian-chip")];
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
  it("asks nothing when this window has opened no session to resolve an identity from", async () => {
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
    expect(politeText(container)).toBe(refusal.detail);
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

  it("draws every trigger at its default when the daemon holds nothing", async () => {
    // The empty store is the state a person ARRIVES in, so it is the one where a
    // sentence and no controls is worst. Every registered trigger gets a switch, and
    // every one of them is tagged as this console's default rather than a reading.
    const container = await renderSettledPage(bridgeServing([]));
    expect(storedSwitches(container)).toHaveLength(ATTENTION_TRIGGERS.length);
    expect(defaultTags(container)).toHaveLength(ATTENTION_TRIGGERS.length);
    expect(container.textContent ?? "").toContain("Nobody has stored a preference for this yet");
    expect(container.textContent ?? "").not.toContain("holds no preference for you yet");
  });

  it("draws one switch per member, labelled with the member's own name", async () => {
    const container = await renderSettledPage(
      bridgeServing([{ key: "attention", value: { mentions: true, runs: false } }]),
    );
    expect(container.textContent ?? "").toContain("attention");
    // The stored record first and in the daemon's own order, then one default per
    // trigger it did not mention — the defaults fill gaps in the SET and never inside
    // a value, so the stored record's two members are still exactly its two.
    expect(storedLabels(container).slice(0, 2)).toStrictEqual(["mentions", "runs"]);
    expect(
      storedSwitches(container)
        .slice(0, 2)
        .map((control) => control.getAttribute("aria-checked")),
    ).toStrictEqual(["true", "false"]);
    expect(defaultTags(container)).toHaveLength(ATTENTION_TRIGGERS.length);
  });

  it("negative control: a value that is not all booleans is shown read-only", async () => {
    // Drawing switches for the boolean members of a mixed record would offer control
    // over a value the console cannot write back intact. The defaults beside it are
    // this console's own rows, so the count subtracts them rather than the case
    // pretending they are not there.
    const container = await renderSettledPage(
      bridgeServing([{ key: "digest", value: { every: "monday", runs: true } }]),
    );
    expect(storedSwitches(container)).toHaveLength(ATTENTION_TRIGGERS.length);
    expect(container.querySelector(".meridian-attention-preferences__opaque")?.textContent).toBe(
      '{"every":"monday","runs":true}',
    );
  });

  it("holds the rows and locks them while the set is read again", async () => {
    // The set is re-read when the window comes back. Blanking it first would read as
    // the console forgetting what it had already told the person.
    const container = await renderSettledPage(
      bridgeServing([{ key: "attention", value: { mentions: true } }]),
    );
    const beforeFocus = storedLabels(container);
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(storedLabels(container)).toStrictEqual(beforeFocus);
    expect(
      container.querySelector('.meridian-attention-preferences[aria-busy="true"]'),
    ).not.toBeNull();
    await settle();
    expect(container.querySelector('.meridian-attention-preferences[aria-busy="true"]')).toBeNull();
  });

  it("negative control: the default tag is absent from a record the daemon stores", async () => {
    // Without this, the two cases above would pass over a page that tagged every row.
    const container = await renderSettledPage(
      bridgeServing([{ key: "mention", value: { mentions: true } }]),
    );
    expect(defaultTags(container)).toHaveLength(ATTENTION_TRIGGERS.length - 1);
  });

  it("announces the settlement once, politely, with what it read", async () => {
    const container = await renderSettledPage(
      bridgeServing([{ key: "attention", value: { mentions: true } }]),
    );
    expect(politeText(container)).toBe("Your notification preferences were read. Stored: 1.");
  });
});

describe("the notifications page — what the operating system allows", () => {
  it("says the question could not be put, rather than that the answer was yes", async () => {
    // No wire serves the permission on this build. Silence would read as "granted",
    // which is the one thing this console must not claim on nobody's behalf.
    const container = await renderSettledPage(bridgeWith({}));
    expect(container.textContent ?? "").toContain(
      "cannot see whether the operating system allows notifications",
    );
  });

  it("names a denied permission and promises in-app attention survives it", async () => {
    const container = await renderSettledPage(
      bridgeWith({
        attentionOsPermissionRead: async () =>
          await Promise.resolve({ status: "served", value: { status: "denied" } } as const),
      }),
    );
    const text = container.textContent ?? "";
    expect(text).toContain("not permitting desktop notifications");
    expect(text).toContain("still reaches the rail");
  });

  it("negative control: a granted permission says nothing at all", async () => {
    const container = await renderSettledPage(
      bridgeWith({
        attentionOsPermissionRead: async () =>
          await Promise.resolve({ status: "served", value: { status: "granted" } } as const),
      }),
    );
    const text = container.textContent ?? "";
    expect(text).not.toContain("not permitting desktop notifications");
    expect(text).not.toContain("cannot see whether the operating system");
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

describe("the notifications page — a read that produced no outcome at all", () => {
  it("renders the identity rejection as a refusal rather than as a read in flight", async () => {
    // The port's contract is that it RESOLVES with an outcome, so a rejection has no
    // arm in its vocabulary. Left unhandled the page kept rendering "Finding out who
    // you are" for the life of the window over a call that had already failed.
    const container = await renderSettledPage(
      bridgeWith({
        callerParticipantRead: async () => {
          await Promise.resolve();
          throw new Error("the identity read never reached the daemon");
        },
      }),
    );

    expect(container.textContent ?? "").toContain("the identity read never reached the daemon");
    expect(container.textContent ?? "").not.toContain("Finding out who you are");
  });

  it("renders the preference rejection the same way, one step further down the chain", async () => {
    const container = await renderSettledPage(
      bridgeWith({
        callerParticipantRead: async () => await Promise.resolve(SERVED_PARTICIPANT),
        attentionPreferenceRead: async () => {
          await Promise.resolve();
          throw new Error("the preference read never reached the store");
        },
      }),
    );

    expect(container.textContent ?? "").toContain("the preference read never reached the store");
    expect(container.textContent ?? "").not.toContain("Reading your preferences");
  });

  it("negative control: a served chain renders switches and no refusal", async () => {
    // Without this, both cases above would hold for a page that rendered a refusal
    // whatever the two reads answered.
    const container = await renderSettledPage(
      bridgeWith({
        callerParticipantRead: async () => await Promise.resolve(SERVED_PARTICIPANT),
        attentionPreferenceRead: async () =>
          await Promise.resolve(servedPreferences([{ key: "attention", value: { runs: true } }])),
      }),
    );

    expect(container.querySelector(".meridian-refusal")).toBeNull();
    expect(storedSwitches(container).length).toBeGreaterThan(0);
  });
});
