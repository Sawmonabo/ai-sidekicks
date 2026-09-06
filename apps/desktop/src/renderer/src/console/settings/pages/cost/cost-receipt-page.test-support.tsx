// The cast both cost-page suites drive the receipt with.
//
// Hoisted because the suite splits on the page's own seam — what it draws, and what
// it withholds from a split that does not add up — and both halves need the same
// receipt builder, the same overridden read, and the same settled render. A second
// copy of the receipt is two files disagreeing about what the accountant serves.

import { cleanup, render } from "@testing-library/react";
import { afterEach, vi } from "vitest";

import { createFixtureBridge, type ConsoleBridge } from "../../../bridge/index.js";
import { LiveAnnouncerProvider } from "../../../primitives/index.js";
import { CommittedFrameRecorder } from "../../committed-frame.test-support.js";
import { CostReceiptPage } from "./CostReceiptPage.js";
import type { CostReceipt, CostReceiptOutcome } from "./cost-receipt-model.js";
import { type SettingsPageContext } from "../../settings-page-registry.js";
import { settle as settlePasses } from "../../../core/settle.test-support.js";

export type FixtureScenario = Parameters<typeof createFixtureBridge>[0]["scenario"];

export const SESSION_ID = "session-cost";

afterEach(() => {
  cleanup();
});

/** A scenario that scripts nothing: the growth override is what these cases drive. */
export const EMPTY_SCENARIO: FixtureScenario = {
  id: "collaboration-cost-test",
  label: "Cost, with nothing scripted",
  purpose: "Drives the cost receipt page against an overridden receipt read.",
  sessionId: SESSION_ID,
  participantIdsInJoinOrder: [],
  beats: [],
  replies: [],
  startedAtIso: "2026-01-01T10:05:00.000Z",
};

/** A budget state whose decomposition members agree with each other. */
export function budgetState(committedSpendCents: number): CostReceipt["sessionTotal"] {
  return {
    sessionId: SESSION_ID,
    costLimitCents: 500_000,
    turnLimitPerAgent: 40,
    maxExecutingChannels: 4,
    maxQueueDepthPerChannel: 8,
    maxPendingOrchestrationRuns: 6,
    activeChildLimit: 2,
    unpricedFamilyCaps: [],
    observedCostCents: committedSpendCents,
    reservedCostCents: 0,
    observedPricedCostCents: committedSpendCents,
    observedUnpricedDebitCents: 0,
    committedSpendCents,
    costStatus: "priced",
  };
}

/** A receipt whose three axes each account for 12,300 cents. */
export function balancedReceipt(): CostReceipt {
  return {
    sessionTotal: budgetState(12_300),
    runs: [
      { runId: "run-alpha", costCents: 8_000, costStatus: "priced", aggregationScope: "run-only" },
      { runId: "run-beta", costCents: 4_300, costStatus: "priced", aggregationScope: "run-only" },
    ],
    causedBy: [
      {
        party: { kind: "participant", participantId: "participant-ana" },
        costCents: 9_000,
        costStatus: "priced",
      },
      { party: { kind: "system" }, costCents: 3_300, costStatus: "priced" },
    ],
    byAccount: [
      {
        providerAccountId: "account-1",
        displayLabel: "work-anthropic",
        billingMode: "subscription",
        costCents: 12_300,
        costStatus: "priced",
      },
    ],
  };
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

/**
 * The real fixture bridge with the one operation this page reads overridden.
 *
 * The refusal arm builds the shipped port's own `growthUnavailable`, not a
 * hand-written envelope, so what these cases assert is what a release build produces.
 */
export function bridgeAnswering(outcome: CostReceiptOutcome): {
  readonly bridge: ConsoleBridge;
  readonly readReceipt: ReturnType<typeof vi.fn>;
} {
  const fixture = createFixtureBridge({ scenario: EMPTY_SCENARIO });
  const readReceipt = vi.fn(async () => await Promise.resolve(outcome));
  return {
    bridge: {
      ...fixture,
      growth: { ...fixture.growth, orchestrationCostReceiptRead: readReceipt },
    },
    readReceipt,
  };
}

export function bridgeServing(receipt: CostReceipt): ConsoleBridge {
  return bridgeAnswering({ status: "served", value: receipt }).bridge;
}

/** Let the one-shot read and the effects it schedules land. */
export async function settle(): Promise<void> {
  await settlePasses(3);
}

/** What one mounted page exposes to a case that moves it between sessions. */
export interface MountedCostPage {
  readonly container: HTMLElement;
  /** Every frame committed since the last {@link MountedCostPage.forgetFrames}. */
  readonly frames: readonly string[];
  readonly forgetFrames: () => void;
  readonly showSession: (retainedSessionId: string | undefined) => void;
}

/**
 * Mount the page beside a recorder, so a case can read the frames it committed.
 *
 * The subject move this supports is one commit long — see
 * `settings/committed-frame.test-support.tsx` — so the case cannot look at the DOM
 * afterwards and see it.
 */
export function renderMovablePage(
  bridge: ConsoleBridge,
  retainedSessionId: string | undefined,
): MountedCostPage {
  const frames: string[] = [];
  const tree = (sessionId: string | undefined): React.JSX.Element => (
    <LiveAnnouncerProvider>
      <CommittedFrameRecorder
        onFrame={(committedText) => {
          frames.push(committedText);
        }}
      >
        <CostReceiptPage context={contextWith(bridge, sessionId)} />
      </CommittedFrameRecorder>
    </LiveAnnouncerProvider>
  );
  const { container, rerender } = render(tree(retainedSessionId));
  return {
    container,
    frames,
    forgetFrames: () => {
      frames.length = 0;
    },
    showSession: (nextSessionId) => {
      rerender(tree(nextSessionId));
    },
  };
}

export function renderPage(
  bridge: ConsoleBridge,
  retainedSessionId: string | undefined,
): HTMLElement {
  const { container } = render(
    <LiveAnnouncerProvider>
      <CostReceiptPage context={contextWith(bridge, retainedSessionId)} />
    </LiveAnnouncerProvider>,
  );
  return container;
}

export async function renderSettledPage(
  bridge: ConsoleBridge,
  retainedSessionId: string | undefined,
): Promise<HTMLElement> {
  const container = renderPage(bridge, retainedSessionId);
  await settle();
  return container;
}

export function politeAnnouncement(container: HTMLElement): string {
  return container.querySelector('[data-live-region="polite"]')?.textContent ?? "";
}

/** The rows of one split's table, by the heading the section carries. */
export function tableRowsUnder(container: HTMLElement, sectionLabel: string): HTMLElement[] {
  const section = container.querySelector<HTMLElement>(`section[aria-label="${sectionLabel}"]`);
  return [...(section?.querySelectorAll<HTMLElement>("tbody tr") ?? [])];
}

export function sectionText(container: HTMLElement, sectionLabel: string): string {
  return (
    container.querySelector<HTMLElement>(`section[aria-label="${sectionLabel}"]`)?.textContent ?? ""
  );
}
