// The cast both notifications-page suites drive the chain with.
//
// The page reads an identity before it reads a preference set, so every case needs
// the same two-step growth wiring; and both halves — what it draws, and what a switch
// sends — read the same switches and labels off the rendered record. Built once here
// so a change to the chain moves one stub rather than two.

import { crossMacrotaskBoundary } from "../../../core/macrotask-boundary.test-support.js";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach } from "vitest";

import { type ConsoleBridge, type GrowthPort } from "../../../bridge/index.js";
import {
  fixtureBridgeWithGrowth,
  unscriptedScenario,
} from "../../../bridge/fixture/fixture-bridge.test-support.js";
import { LiveAnnouncerProvider } from "../../../primitives/index.js";
import {
  renderMovablePage,
  settingsPageContextWith,
  type MountedMovablePage,
} from "../../settings-page-mount.test-support.js";
import { NotificationsPage } from "./NotificationsPage.js";
// The caller participant every notifications suite reads as, from the module that
// DECLARES it: the page chain and the writer chain answer for the same person, and a
// second copy of the id here is how one of them comes to read as somebody else.
import { PARTICIPANT_ID } from "./notification-preference-writer.test-support.js";
import type {
  AttentionPreference,
  AttentionPreferenceReadOutcome,
  CallerParticipantOutcome,
} from "./attention-preference-model.js";
import { settle as settleReactWork } from "../../../core/settle.test-support.js";
import { settleScheduledRead } from "../../../bridge/readings/scheduled-read.test-support.js";

import type { ConsoleScenario } from "../../../bridge/scenario-runtime/scenario.js";

export const SESSION_ID = "session-notifications";

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

/**
 * How many scheduler windows the page's read chain crosses before it has settled.
 *
 * TWO, AND BOTH OF THEM ARE READS. The identity read is scheduled now — it takes the
 * window's own triggers so a refused one is asked again on the next focus — and the
 * participant it names is the subject the preference reading is minted under, so that
 * reading does not exist to ask for its own set until the first window has elapsed and
 * answered. A harness that advanced once would fire the identity read and then report
 * the absence of a preference read it never gave the scheduler a chance to perform.
 */
const CHAINED_READ_WINDOWS = 2;

/**
 * Let the chained reads, the write, and the re-read all land.
 *
 * BOTH READS CROSS A SCHEDULER, and both are armed on the fixture's FROZEN clock, so a
 * case that only drained React would advance nothing at all. The bridge is a parameter
 * because the clock is the bridge's. React's own queue is drained between the windows
 * as well as before them: the identity reply commits a render, and it is that render
 * that mints the reading which asks for the set.
 */
export async function settle(bridge: ConsoleBridge): Promise<void> {
  for (let window = 0; window < CHAINED_READ_WINDOWS; window += 1) {
    await settleReactWork();
    await settleScheduledRead(bridge);
  }
  await settleReactWork();
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
  await settle(bridge);
  return container;
}

/** Mount the notifications page beside a recorder. See the family's shared harness. */
export function renderMovableNotificationsPage(
  bridge: ConsoleBridge,
  retainedSessionId: string | undefined,
): MountedMovablePage {
  return renderMovablePage(
    (context) => <NotificationsPage context={context} />,
    bridge,
    retainedSessionId,
  );
}

export function renderPageAt(
  bridge: ConsoleBridge,
  retainedSessionId: string | undefined,
): HTMLElement {
  const { container } = render(
    <LiveAnnouncerProvider>
      <NotificationsPage context={settingsPageContextWith(bridge, retainedSessionId)} />
    </LiveAnnouncerProvider>,
  );
  return container;
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

/**
 * Press one control and let what it started land.
 *
 * React's queue only, and deliberately: a press starts a write, and the re-read behind
 * a served write is taken straight rather than scheduled — the writer needs the value
 * in its own loop. Advancing the clock here would settle a read nothing had asked for.
 */
export async function press(element: HTMLElement | undefined): Promise<void> {
  await act(async () => {
    element?.click();
    await crossMacrotaskBoundary();
  });
  await settleReactWork();
}
