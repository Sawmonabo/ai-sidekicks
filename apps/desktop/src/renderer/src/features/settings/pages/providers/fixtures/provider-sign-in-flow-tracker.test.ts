// One brokered sign-in at a time, and where the second press lands. These cases state the
// page's claim on the tracker: `AccountsFixtureBody.test.ts` asserts the control is disabled
// with its reason, but a control is a courtesy, so these assert what happens to a press it did
// not stop (a stale frame, a keyboard activation racing the commit that disabled it). They
// drive the real `ProviderSignInFlowTracker` over the real `startProviderSignIn` with stub
// calls; the single-flight guard is `lib/reads/generation-latch.ts`, so a case fails if its
// refusal contract changes.

import { describe, expect, it, vi } from "vitest";

import type { ProviderAccountId } from "@ai-sidekicks/contracts/provider/account/account";

import { crossMacrotaskBoundary } from "@test/helpers/macrotask-boundary.js";
import {
  accountPlaneCalls,
  PROVIDER_SIGN_IN_ATTEMPT,
  type AccountPlaneCalls,
} from "./account-plane-bridge.test-support.js";
import type { ProviderLoginCompletion } from "@renderer/services/provider-accounts/provider-account-deliveries.js";
import { startProviderSignIn } from "./provider-sign-in-flow.js";
import {
  ProviderSignInFlowTracker,
  findRunningProviderSignInAccountId,
} from "./provider-sign-in-flow-tracker.js";

const RUNNING_ACCOUNT_ID = "pa-0001" as ProviderAccountId;
const WAITING_ACCOUNT_ID = "pa-0002" as ProviderAccountId;

/**
 * A tracker over stub calls, bound the way the fixture body binds it. The real
 * `startProviderSignIn` is used so a case drives the outcome narrowing it performs too.
 */
function trackerOver(
  calls: AccountPlaneCalls,
  onFlowSettled: () => void = (): void => undefined,
): ProviderSignInFlowTracker {
  return new ProviderSignInFlowTracker({
    startProviderSignIn: async (accountId) => await startProviderSignIn(calls.login, accountId),
    cancelProviderSignIn: async (attempt) => {
      await calls.cancelLogin({ attemptId: attempt.attemptId });
    },
    onFlowSettled,
  });
}

/** The registry's report that one attempt is over, with how it ended. */
function completionOf(
  attemptId: string,
  outcome: ProviderLoginCompletion["outcome"],
  failureReason?: string,
): ProviderLoginCompletion {
  return {
    kind: "login_completed",
    attemptId,
    accountId: RUNNING_ACCOUNT_ID,
    outcome,
    ...(failureReason === undefined ? {} : { failureReason }),
  };
}

/** A tracker whose start is served and whose cancel is honored. */
function trackerOverServedCalls(): {
  readonly tracker: ProviderSignInFlowTracker;
  readonly calls: AccountPlaneCalls;
  readonly onFlowSettled: ReturnType<typeof vi.fn>;
} {
  const onFlowSettled = vi.fn();
  const calls = accountPlaneCalls({
    login: PROVIDER_SIGN_IN_ATTEMPT,
    cancel: { status: "canceled" },
  });
  return { tracker: trackerOver(calls, onFlowSettled), calls, onFlowSettled };
}

describe("ProviderSignInFlowTracker", () => {
  it("refuses a second start while the first is in flight, and sends nothing for it", async () => {
    const { tracker, calls } = trackerOverServedCalls();

    // Deliberately not awaited: the window under test is the first start dispatched and
    // unanswered, while a person looks at a control not yet re-rendered as disabled.
    tracker.start(RUNNING_ACCOUNT_ID);
    tracker.start(WAITING_ACCOUNT_ID);

    const inFlight = tracker.snapshot();
    expect(inFlight.flow).toEqual({ kind: "starting", accountId: RUNNING_ACCOUNT_ID });
    expect(inFlight.refusalByAccountId.has(WAITING_ACCOUNT_ID)).toBe(true);
    expect(inFlight.refusalByAccountId.has(RUNNING_ACCOUNT_ID)).toBe(false);

    await crossMacrotaskBoundary();

    // The first start's settlement is untouched by the refusal: the flow is live and carries the
    // attempt the provider answered with.
    const settled = tracker.snapshot();
    expect(settled.flow).toEqual({
      kind: "live",
      accountId: RUNNING_ACCOUNT_ID,
      attempt: PROVIDER_SIGN_IN_ATTEMPT,
    });
    expect(settled.refusalByAccountId.has(WAITING_ACCOUNT_ID)).toBe(true);
    expect(findRunningProviderSignInAccountId(tracker.snapshot())).toBe(RUNNING_ACCOUNT_ID);
    // The refusal is the console's own and the daemon was never asked, so it arrives in the
    // same tick as the press.
    expect(calls.login).toHaveBeenCalledTimes(1);
    expect(calls.login).toHaveBeenCalledWith({ accountId: RUNNING_ACCOUNT_ID });
  });

  it("never installs a refused start as the tracked flow", async () => {
    const { tracker } = trackerOverServedCalls();

    tracker.start(RUNNING_ACCOUNT_ID);
    await crossMacrotaskBoundary();
    tracker.start(WAITING_ACCOUNT_ID);

    // The card that renders a flow is shared across every readiness row, so a refusal shown
    // there would be about no particular account and would take the code and cancel with it.
    expect(tracker.snapshot().flow.kind).toBe("live");
  });

  it("offers the tracker again once the running flow has been canceled", async () => {
    const { tracker, onFlowSettled } = trackerOverServedCalls();

    tracker.start(RUNNING_ACCOUNT_ID);
    await crossMacrotaskBoundary();
    tracker.cancel();
    await crossMacrotaskBoundary();

    expect(tracker.snapshot().flow.kind).toBe("idle");
    expect(onFlowSettled).toHaveBeenCalledTimes(1);
    expect(findRunningProviderSignInAccountId(tracker.snapshot())).toBeUndefined();

    // Negative control for the guard: a single-flight key never released would make every later
    // start unreachable.
    tracker.start(WAITING_ACCOUNT_ID);
    expect(tracker.snapshot().flow).toEqual({ kind: "starting", accountId: WAITING_ACCOUNT_ID });
    expect(tracker.snapshot().refusalByAccountId.has(WAITING_ACCOUNT_ID)).toBe(false);
  });

  it("clears the flow when the registry reports the attempt finished", async () => {
    // The second thing that ends a flow: `providerAccount.subscribe` carries `login_completed`
    // correlated on the attempt id, which is evidence the process stopped, so a tracker still
    // holding an attempt is released by the registry.
    const { tracker, onFlowSettled } = trackerOverServedCalls();

    tracker.start(RUNNING_ACCOUNT_ID);
    await crossMacrotaskBoundary();
    tracker.noteLoginCompleted(completionOf(PROVIDER_SIGN_IN_ATTEMPT.attemptId, "succeeded"));

    expect(tracker.snapshot().flow.kind).toBe("idle");
    expect(onFlowSettled).toHaveBeenCalledTimes(1);
    tracker.start(WAITING_ACCOUNT_ID);
    expect(tracker.snapshot().flow).toEqual({ kind: "starting", accountId: WAITING_ACCOUNT_ID });
  });

  // Negative control: the correlation is on the attempt id, so another window's completion must
  // not take this card down; otherwise a tracker ending on any completion would pass.
  it("leaves the flow alone for a completion naming another attempt", async () => {
    const { tracker, onFlowSettled } = trackerOverServedCalls();

    tracker.start(RUNNING_ACCOUNT_ID);
    await crossMacrotaskBoundary();
    tracker.noteLoginCompleted(completionOf("some-other-attempt", "failed", "Code expired"));

    expect(tracker.snapshot().flow.kind).toBe("live");
    expect(onFlowSettled).not.toHaveBeenCalled();
  });

  it("ends a failed flow whose completion arrived before the start reply recorded it", async () => {
    // The tail opens before `providerAccount.login` is called, so a flow that finishes fast
    // reports its completion while the start reply is still traveling; the tracker would
    // otherwise record an attempt that is already over and hold the key until cancel. A failed
    // attempt stays on screen as not finished, with the provider's own reason.
    const { tracker, onFlowSettled } = trackerOverServedCalls();

    tracker.start(RUNNING_ACCOUNT_ID);
    tracker.noteLoginCompleted(
      completionOf(PROVIDER_SIGN_IN_ATTEMPT.attemptId, "failed", "Code expired"),
    );
    await crossMacrotaskBoundary();

    expect(tracker.snapshot().flow).toEqual({ kind: "unfinished", failureReason: "Code expired" });
    expect(onFlowSettled).toHaveBeenCalledTimes(1);
    expect(findRunningProviderSignInAccountId(tracker.snapshot())).toBeUndefined();
  });

  it("installs nothing once disposed", async () => {
    const { tracker } = trackerOverServedCalls();

    tracker.start(RUNNING_ACCOUNT_ID);
    tracker.dispose();
    await crossMacrotaskBoundary();

    expect(tracker.snapshot().flow).toEqual({ kind: "starting", accountId: RUNNING_ACCOUNT_ID });
    tracker.start(WAITING_ACCOUNT_ID);
    expect(tracker.snapshot().refusalByAccountId.size).toBe(0);
  });
});
