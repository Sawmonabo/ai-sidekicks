// What the notifications page reads, and what it draws from it.
//
// The machine-local mute, the per-session tier it never offers, the chain that starts
// with the identity read, and the record it draws one switch per member from. What a
// switch SENDS is `NotificationsPage.writing.test.tsx`, over the one cast in
// `notifications-page.test-support.tsx`.
import type { ConsoleBridge } from "../../../bridge/index.js";
import { describe, expect, it, vi } from "vitest";
import { growthUnavailable } from "../../../bridge/index.js";
import { registerNotificationsPage } from "./NotificationsPage.js";
import type { AttentionPreference } from "./attention-preference-model.js";
import { SettingsPageRegistry } from "../../settings-page-registry.js";
import {
  PARTICIPANT_ID,
  SERVED_PARTICIPANT,
  bridgeWith,
  politeAnnouncement,
  press,
  renderPageAt,
  renderSettledPage,
  servedPreferences,
  settle,
  storedLabels,
  storedSwitches,
} from "./notifications-page.test-support.js";

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
