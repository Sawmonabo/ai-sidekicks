// The cast both notifications-page suites drive the chain with.
//
// The page reads an identity before it reads a preference set, so every case needs
// the same two-step growth wiring; and both halves — what it draws, and what a switch
// sends — read the same switches and labels off the rendered record. Built once here
// so a change to the chain moves one stub rather than two.

import { act, cleanup, render } from "@testing-library/react";
import { afterEach } from "vitest";

import { type ConsoleBridge, type GrowthPort } from "../../../bridge/index.js";
import {
  fixtureBridgeWithGrowth,
  unscriptedScenario,
} from "../../../bridge/fixture-bridge-overrides.test-support.js";
import { LiveAnnouncerProvider } from "../../../primitives/index.js";
import { NotificationsPage } from "./NotificationsPage.js";
import type {
  AttentionPreference,
  AttentionPreferenceReadOutcome,
  CallerParticipantOutcome,
} from "./attention-preference-model.js";
import { type SettingsPageContext } from "../../settings-page-registry.js";
import { settle as settlePasses } from "../../../core/settle.test-support.js";

import type { ConsoleScenario } from "../../../bridge/scenario.js";

export const SESSION_ID = "session-notifications";
export const PARTICIPANT_ID = "participant-ana";

afterEach(() => {
  cleanup();
});

/** A scenario that scripts nothing: the growth overrides are what these cases drive. */
export const SCENARIO: ConsoleScenario = unscriptedScenario("collaboration-notifications-test");

export const SERVED_PARTICIPANT: CallerParticipantOutcome = {
  status: "served",
  value: { participantId: PARTICIPANT_ID },
};

/** The real fixture bridge, with only the operations a case drives overridden. */
export function bridgeWith(growthOverrides: Partial<GrowthPort>): ConsoleBridge {
  return fixtureBridgeWithGrowth(SCENARIO, growthOverrides);
}

export function servedPreferences(
  preferences: readonly AttentionPreference[],
): AttentionPreferenceReadOutcome {
  return { status: "served", value: { preferences } };
}

export function contextWith(
  bridge: ConsoleBridge,
  retainedSessionId: string | undefined,
): SettingsPageContext {
  return {
    bridge,
    openSection: () => undefined,
    retainedSessionId,
    retainedSessionStore: undefined,
  } satisfies SettingsPageContext;
}

/** Let the chained reads, the write, and the re-read all land. */
export async function settle(): Promise<void> {
  await settlePasses(8);
}

/**
 * Mount in a window that has opened a session.
 *
 * The session id is not a default parameter: passing `undefined` to one would take
 * the default rather than the absence, which is precisely the case the
 * no-session test exists to drive. That test calls {@link renderPageAt} instead.
 */
export async function renderSettledPage(bridge: ConsoleBridge): Promise<HTMLElement> {
  const container = renderPageAt(bridge, SESSION_ID);
  await settle();
  return container;
}

export function renderPageAt(
  bridge: ConsoleBridge,
  retainedSessionId: string | undefined,
): HTMLElement {
  const { container } = render(
    <LiveAnnouncerProvider>
      <NotificationsPage context={contextWith(bridge, retainedSessionId)} />
    </LiveAnnouncerProvider>,
  );
  return container;
}

export function politeAnnouncement(container: HTMLElement): string {
  return container.querySelector('[data-live-region="polite"]')?.textContent ?? "";
}

export function storedSwitches(container: HTMLElement): HTMLElement[] {
  return [
    ...container.querySelectorAll<HTMLElement>(
      ".meridian-attention-preferences .meridian-settings-row__switch",
    ),
  ];
}

/** One rendered record, by position. Throws rather than casting an absent one. */
export function storedRecordAt(container: HTMLElement, index: number): HTMLElement {
  const record = container.querySelectorAll<HTMLElement>(".meridian-attention-preferences__row")[
    index
  ];
  if (record === undefined) {
    throw new Error(`no stored preference record was rendered at position ${String(index)}`);
  }
  return record;
}

export function switchesIn(record: HTMLElement): HTMLElement[] {
  return [...record.querySelectorAll<HTMLElement>(".meridian-settings-row__switch")];
}

export function storedLabels(container: HTMLElement): string[] {
  return [
    ...container.querySelectorAll<HTMLElement>(
      ".meridian-attention-preferences .meridian-settings-row__label",
    ),
  ].map((element) => element.textContent ?? "");
}

export async function press(element: HTMLElement | undefined): Promise<void> {
  await act(async () => {
    element?.click();
    await Promise.resolve();
  });
  await settle();
}
