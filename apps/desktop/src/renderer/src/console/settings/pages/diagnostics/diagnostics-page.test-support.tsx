// The cast every diagnostics suite drives the page with.
//
// Hoisted because the page splits three ways — what it reads, what it renders per
// region, and what the recovery mutation does — and all three need the same growth
// overrides, the same store, and the same settled render. A second copy of the served
// reply is two files disagreeing about what the node answers.
//
// THE OVERRIDES SIT ON THE REAL FIXTURE BRIDGE. The refusal arms are built by the
// shipped port rather than hand-written here, so what these cases assert is what a
// release build produces — including the code and the sentence a refusal carries.

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, vi, type Mock } from "vitest";

import type { RunState } from "@ai-sidekicks/contracts";

import {
  SidekicksBridgeProvider,
  createFixtureBridge,
  growthUnavailable,
  type ConsoleBridge,
  type GrowthFailureDetail,
  type GrowthHealthStatus,
  type GrowthOperationId,
  type GrowthOutcome,
  type GrowthRecoveryReceipt,
  type GrowthRedactionPolicy,
  type GrowthStuckRunInspection,
} from "../../../bridge/index.js";
import { LiveAnnouncerProvider } from "../../../primitives/index.js";
import { crossMacrotaskBoundary } from "../../../core/macrotask-boundary.test-support.js";
import { PAST_REFRESH_DEBOUNCE_MS, settle } from "../../../core/settle.test-support.js";
import { frozenClockOf } from "../../../bridge/readings/scheduled-read.test-support.js";
import { settingsPageContextWith } from "../../settings-page-mount.test-support.js";
import type { SessionStore } from "../../../store/index.js";
import { DiagnosticsPage } from "./DiagnosticsPage.js";

export type FixtureScenario = Parameters<typeof createFixtureBridge>[0]["scenario"];

export const SESSION_ID = "session-diagnostics";
export const STALLED_RUN_ID = "run-stalled";
export const FAILED_RUN_ID = "run-failed";

afterEach(() => {
  cleanup();
});

/** A scenario that scripts nothing: the growth overrides are what these cases drive. */
export const EMPTY_SCENARIO: FixtureScenario = {
  id: "collaboration-diagnostics-test",
  label: "Diagnostics, with nothing scripted",
  purpose: "Drives the diagnostics page against overridden health reads.",
  sessionId: SESSION_ID,
  participantIdsInJoinOrder: [],
  beats: [],
  replies: [],
  startedAtIso: "2026-01-01T08:00:00.000Z",
};

/** A node reporting one healthy component, one degraded, one blocked. */
export function degradedStatus(): GrowthHealthStatus {
  return {
    overall: "degraded",
    components: [
      { name: "daemon", state: "healthy", lastChecked: "2026-01-01T07:59:50.000Z" },
      { name: "provider", state: "degraded", lastChecked: "2026-01-01T07:59:50.000Z" },
      { name: "replay", state: "blocked", lastChecked: "2026-01-01T07:59:20.000Z" },
    ],
  };
}

/** A node reporting every component it checked as healthy. */
export function healthyStatus(): GrowthHealthStatus {
  return {
    overall: "healthy",
    components: [
      { name: "daemon", state: "healthy", lastChecked: "2026-01-01T07:59:50.000Z" },
      { name: "provider", state: "healthy", lastChecked: "2026-01-01T07:59:50.000Z" },
    ],
  };
}

/** An inspection that suspects a stall, quiet since `lastProgressAt`. */
export function stuckInspection(lastProgressAt: string): GrowthStuckRunInspection {
  return {
    runId: STALLED_RUN_ID,
    currentState: "running",
    lastProgressAt,
    lastEventTime: lastProgressAt,
    blockingReason: "the provider has not written a frame since the last tool result",
    healthSignal: "stuck-suspected",
    suggestedAction: "escalate",
  };
}

/** An inspection that found the run moving. */
export function movingInspection(): GrowthStuckRunInspection {
  return {
    runId: STALLED_RUN_ID,
    currentState: "running",
    lastProgressAt: "2026-01-01T07:59:59.000Z",
    lastEventTime: "2026-01-01T07:59:59.000Z",
    healthSignal: "healthy",
  };
}

export function failureDetail(): GrowthFailureDetail {
  return {
    runId: FAILED_RUN_ID,
    failureCategory: "provider failure",
    recoveryCondition: "provider_unavailable",
    humanSummary: "The provider closed the connection while the turn was in flight.",
    technicalDetails: { attempts: 2, lastStatus: 503 },
    occurredAt: "2026-01-01T07:56:20.000Z",
  };
}

/** A policy with an override in force and one bucket keeping raw content. */
export function overriddenPolicy(): GrowthRedactionPolicy {
  return {
    buckets: [
      { bucket: "driver_raw_events", ttlDays: 7, rawContentOptIn: false },
      { bucket: "command_output", ttlDays: 7, rawContentOptIn: false },
      { bucket: "tool_traces", ttlDays: 45, rawContentOptIn: true },
      { bucket: "reasoning_detail", ttlDays: 7, rawContentOptIn: false },
    ],
    outboundDefault: "deny",
    retentionPolicyOverrideActive: true,
  };
}

export function recoveryReceipt(newState: RunState): GrowthRecoveryReceipt {
  return {
    runId: STALLED_RUN_ID,
    previousState: "running",
    newState,
    actionTaken: "interrupt",
  };
}

/** What one case wants the four reads and the mutation to answer. */
export interface DiagnosticsScript {
  readonly status?: GrowthHealthStatus;
  readonly stall?: GrowthStuckRunInspection;
  readonly failure?: GrowthFailureDetail;
  readonly policy?: GrowthRedactionPolicy;
  readonly recovery?: GrowthRecoveryReceipt;
  /** Operations that should answer the port's own refusal instead of a value. */
  readonly refuse?: readonly (keyof DiagnosticsScript)[];
}

/**
 * One overridden operation, answering a value or the port's own refusal.
 *
 * The refusal is `growthUnavailable`'s — the shipped port's builder, carrying the
 * slate row's wire name and the code a release build refuses with — rather than an
 * envelope written here, so a case asserting on a refusal is asserting on production
 * text. `served === undefined` refuses for the same reason the default does: a case
 * that wanted an answer says which one.
 */
function answering<TValue>(
  operationId: GrowthOperationId,
  served: TValue | undefined,
  isRefused: boolean,
): Mock<() => Promise<GrowthOutcome<TValue>>> {
  const outcome: GrowthOutcome<TValue> =
    served === undefined || isRefused
      ? growthUnavailable(operationId)
      : { status: "served", value: served };
  return vi.fn(async () => await Promise.resolve(outcome));
}

/** The five overridden operations a case can assert were called. */
export interface DiagnosticsCalls {
  readonly status: Mock<() => Promise<GrowthOutcome<GrowthHealthStatus>>>;
  readonly stall: Mock<() => Promise<GrowthOutcome<GrowthStuckRunInspection>>>;
  readonly failure: Mock<() => Promise<GrowthOutcome<GrowthFailureDetail>>>;
  readonly policy: Mock<() => Promise<GrowthOutcome<GrowthRedactionPolicy>>>;
  readonly recovery: Mock<() => Promise<GrowthOutcome<GrowthRecoveryReceipt>>>;
}

/**
 * The real fixture bridge with the five diagnostics operations overridden.
 *
 * Written out rather than composed in a loop, because a loop cannot keep the five
 * value types apart and the cast that would make it compile is exactly the thing that
 * would let a case script a policy into the status read.
 */
export function bridgeAnswering(script: DiagnosticsScript): {
  readonly bridge: ConsoleBridge;
  readonly calls: DiagnosticsCalls;
} {
  const fixture = createFixtureBridge({ scenario: EMPTY_SCENARIO });
  const isRefused = (member: keyof DiagnosticsScript): boolean =>
    script.refuse?.includes(member) === true;
  const calls: DiagnosticsCalls = {
    status: answering("healthStatusRead", script.status, isRefused("status")),
    stall: answering("healthStuckRunInspect", script.stall, isRefused("stall")),
    failure: answering("healthFailureDetailRead", script.failure, isRefused("failure")),
    policy: answering("healthRedactionPolicyRead", script.policy, isRefused("policy")),
    recovery: answering("healthRecoveryActionRequest", script.recovery, isRefused("recovery")),
  };
  return {
    bridge: {
      ...fixture,
      growth: {
        ...fixture.growth,
        healthStatusRead: calls.status,
        healthStuckRunInspect: calls.stall,
        healthFailureDetailRead: calls.failure,
        healthRedactionPolicyRead: calls.policy,
        healthRecoveryActionRequest: calls.recovery,
      },
    },
    calls,
  };
}

/**
 * Mount the page under the bridge provider.
 *
 * Under the provider because the read-out takes the window's clock from
 * `useConsoleClock`, which is the console's one answer to which clock a window runs
 * on and the resolution the provider's own error message says every console surface
 * renders inside.
 */
export function renderPage(bridge: ConsoleBridge, sessionStore?: SessionStore): HTMLElement {
  const { container } = render(
    <SidekicksBridgeProvider bridge={bridge}>
      <LiveAnnouncerProvider>
        <DiagnosticsPage context={settingsPageContextWith(bridge, SESSION_ID, sessionStore)} />
      </LiveAnnouncerProvider>
    </SidekicksBridgeProvider>,
  );
  return container;
}

/** Mount, carry the debounced read past its window, and let the four settle. */
export async function renderSettledPage(
  bridge: ConsoleBridge,
  sessionStore?: SessionStore,
): Promise<HTMLElement> {
  const container = renderPage(bridge, sessionStore);
  await act(async () => {
    frozenClockOf(bridge).advance(PAST_REFRESH_DEBOUNCE_MS);
    await crossMacrotaskBoundary();
  });
  await settle();
  return container;
}

/** One region's rendered text, by the label its section carries. */
export function regionText(container: HTMLElement, heading: string): string {
  return (
    container.querySelector<HTMLElement>(`section[aria-label="${heading}"]`)?.textContent ?? ""
  );
}

/**
 * Open one recovery confirmation and answer it.
 *
 * TWO PRESSES, because a recovery request is two acts: the trigger states the
 * consequence and the answer settles it.
 *
 * THE SECOND PRESS IS SCOPED TO THE DIALOG, which is the whole reason this is a
 * helper. The trigger and the confirming button carry the SAME word — the action's —
 * so a document-wide search by text finds the trigger again and the request is never
 * sent, silently. The dialog is portalled to the document body, so it is looked for
 * there rather than inside the page.
 */
export async function answerRecoveryConfirmation(
  container: HTMLElement,
  action: "Try again" | "Interrupt" | "Abandon",
  answer: "confirm" | "Not now",
): Promise<void> {
  await openRecoveryConfirmation(container, action);
  const dialog = document.body.querySelector<HTMLElement>(".meridian-confirm");
  const answerLabel = answer === "confirm" ? action : answer;
  const settleButton = [...(dialog?.querySelectorAll("button") ?? [])].find(
    (button) => button.textContent === answerLabel,
  );
  await act(async () => {
    settleButton?.click();
    await crossMacrotaskBoundary();
  });
  await settle();
}

/** Press one recovery trigger and leave its confirmation open. */
export async function openRecoveryConfirmation(
  container: HTMLElement,
  action: "Try again" | "Interrupt" | "Abandon",
): Promise<void> {
  const prompt = container.querySelector<HTMLElement>(".meridian-recovery-prompt__actions");
  const trigger = [...(prompt?.querySelectorAll("button") ?? [])].find(
    (button) => button.textContent === action,
  );
  await act(async () => {
    trigger?.click();
    await crossMacrotaskBoundary();
  });
  await settle();
}
