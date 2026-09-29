// One brokered sign-in at a time, and where the second press lands.
//
// THE CASES BELOW ARE THE PAGE'S CLAIM STATED AT THE PLANE. `AccountsShell.test.tsx`
// asserts that the control is disabled with its reason on screen; a control is a
// courtesy, and these cases assert what happens to a press it did not stop — a stale
// frame, a keyboard activation racing the commit that disabled it.
//
// EVERY CASE DRIVES THE REAL `SignInPlane` over the real `startSignIn` and `cancelSignIn`
// with stub calls. The single-flight guard under test is `store/read/generation-latch.ts`,
// reached exactly as the shipped module reaches it, so a case here fails if that
// register's refusal contract changes.

import { describe, expect, it, vi } from "vitest";

import type { ProviderAccountId } from "@ai-sidekicks/contracts";

import { crossMacrotaskBoundary } from "@test/helpers/macrotask-boundary.js";
import {
  accountPlaneCalls,
  SIGN_IN_ATTEMPT,
  type AccountPlaneCalls,
} from "./account-plane-bridge.test-support.js";
import { cancelSignIn, startSignIn } from "./sign-in-flow.js";
import { SignInPlane, signInHeldSentence, signInPlaneHolder } from "./sign-in-flow-tracker.js";

const RUNNING_ACCOUNT_ID = "pa-0001" as ProviderAccountId;
const WAITING_ACCOUNT_ID = "pa-0002" as ProviderAccountId;

/**
 * A plane over stub calls, bound the way the shell binds it.
 *
 * The real `startSignIn` and `cancelSignIn` rather than stubs of them, so a case here
 * drives the outcome narrowing those functions perform as well as the plane's own rule.
 */
function planeOver(
  calls: AccountPlaneCalls,
  onFlowSettled: () => void = (): void => undefined,
): SignInPlane {
  return new SignInPlane({
    startSignIn: async (accountId) => await startSignIn(calls.login, accountId),
    cancelSignIn: async (attempt) => await cancelSignIn(calls.cancelLogin, attempt),
    onFlowSettled,
  });
}

/** A plane whose start is served and whose cancel is honored. */
function planeOverServedCalls(): {
  readonly plane: SignInPlane;
  readonly calls: AccountPlaneCalls;
  readonly onFlowSettled: ReturnType<typeof vi.fn>;
} {
  const onFlowSettled = vi.fn();
  const calls = accountPlaneCalls({ login: SIGN_IN_ATTEMPT, cancel: { status: "cancelled" } });
  return { plane: planeOver(calls, onFlowSettled), calls, onFlowSettled };
}

describe("SignInPlane", () => {
  it("refuses a second start raised while the first is still in flight", async () => {
    const { plane } = planeOverServedCalls();

    // Deliberately NOT awaited: the window this closes is the one where the first
    // start has been dispatched and has not answered, which is exactly when a person
    // is looking at a control that has not yet been re-rendered as disabled.
    plane.start(RUNNING_ACCOUNT_ID);
    plane.start(WAITING_ACCOUNT_ID);

    const inFlight = plane.snapshot();
    expect(inFlight.flow).toEqual({ kind: "starting", accountId: RUNNING_ACCOUNT_ID });
    expect(inFlight.refusalByAccountId.has(WAITING_ACCOUNT_ID)).toBe(true);
    expect(inFlight.refusalByAccountId.has(RUNNING_ACCOUNT_ID)).toBe(false);

    await crossMacrotaskBoundary();

    // The first start's own settlement is untouched by the refusal: the flow is live,
    // it carries the attempt the provider answered with, and the row that was refused
    // still says so.
    const settled = plane.snapshot();
    expect(settled.flow).toEqual({
      kind: "live",
      accountId: RUNNING_ACCOUNT_ID,
      attempt: SIGN_IN_ATTEMPT,
    });
    expect(settled.refusalByAccountId.has(WAITING_ACCOUNT_ID)).toBe(true);
    expect(signInPlaneHolder(plane.snapshot())).toBe(RUNNING_ACCOUNT_ID);
  });

  it("sends nothing for the refused start", async () => {
    const { plane, calls } = planeOverServedCalls();

    plane.start(RUNNING_ACCOUNT_ID);
    plane.start(WAITING_ACCOUNT_ID);
    await crossMacrotaskBoundary();

    // The refusal is the console's own and the daemon was never asked, which is what
    // makes it arrive in the same tick as the press rather than a round trip later.
    expect(calls.login).toHaveBeenCalledTimes(1);
    expect(calls.login).toHaveBeenCalledWith({ accountId: RUNNING_ACCOUNT_ID });
  });

  it("names the account in the way, and says something different when it is your own", async () => {
    const { plane } = planeOverServedCalls();

    plane.start(RUNNING_ACCOUNT_ID);
    await crossMacrotaskBoundary();
    plane.start(WAITING_ACCOUNT_ID);
    plane.start(RUNNING_ACCOUNT_ID);

    const { refusalByAccountId } = plane.snapshot();
    expect(refusalByAccountId.get(WAITING_ACCOUNT_ID)?.detail).toBe(
      signInHeldSentence({ isTheSameAccount: false, holdingAccountLabel: undefined }),
    );
    expect(refusalByAccountId.get(RUNNING_ACCOUNT_ID)?.detail).toBe(
      signInHeldSentence({ isTheSameAccount: true, holdingAccountLabel: undefined }),
    );
  });

  it("never installs a refused start as the tracked flow", async () => {
    const { plane } = planeOverServedCalls();

    plane.start(RUNNING_ACCOUNT_ID);
    await crossMacrotaskBoundary();
    plane.start(WAITING_ACCOUNT_ID);

    // The card that renders a flow is shared across every readiness row, so a refusal
    // shown there would be a refusal about no particular account — and it would take
    // the verification code and the cancel control with it.
    expect(plane.snapshot().flow.kind).toBe("live");
  });

  it("offers the plane again once the running flow has been cancelled", async () => {
    const { plane, onFlowSettled } = planeOverServedCalls();

    plane.start(RUNNING_ACCOUNT_ID);
    await crossMacrotaskBoundary();
    plane.cancel();
    await crossMacrotaskBoundary();

    expect(plane.snapshot().flow.kind).toBe("ended");
    expect(onFlowSettled).toHaveBeenCalledTimes(1);
    expect(signInPlaneHolder(plane.snapshot())).toBeUndefined();

    // The negative control for the guard itself: a single-flight key that were never
    // released would make every later start unreachable, and the surface would sit
    // with every control disabled for the rest of the page's life.
    plane.start(WAITING_ACCOUNT_ID);
    expect(plane.snapshot().flow).toEqual({ kind: "starting", accountId: WAITING_ACCOUNT_ID });
    expect(plane.snapshot().refusalByAccountId.has(WAITING_ACCOUNT_ID)).toBe(false);
  });

  it("clears the flow when the registry reports the attempt finished", async () => {
    // The second of the two things that end a flow. `providerAccount.subscribe` carries
    // `login_completed` correlated on the attempt id, and that IS evidence the process
    // stopped — so a plane still holding an attempt is released by the registry rather
    // than staying claimed for the life of the window.
    const { plane, onFlowSettled } = planeOverServedCalls();

    plane.start(RUNNING_ACCOUNT_ID);
    await crossMacrotaskBoundary();
    plane.noteLoginCompleted(SIGN_IN_ATTEMPT.attemptId);

    expect(plane.snapshot().flow.kind).toBe("ended");
    expect(onFlowSettled).toHaveBeenCalledTimes(1);
    plane.start(WAITING_ACCOUNT_ID);
    expect(plane.snapshot().flow).toEqual({ kind: "starting", accountId: WAITING_ACCOUNT_ID });
  });

  // The negative control for the case above: the correlation is on the attempt id, so a
  // completion for some other attempt — another window's brokered flow — must not take
  // this one's card down. Without it the case would hold for a plane that ended on any
  // completion at all.
  it("leaves the flow alone for a completion naming another attempt", async () => {
    const { plane, onFlowSettled } = planeOverServedCalls();

    plane.start(RUNNING_ACCOUNT_ID);
    await crossMacrotaskBoundary();
    plane.noteLoginCompleted("some-other-attempt");

    expect(plane.snapshot().flow.kind).toBe("live");
    expect(onFlowSettled).not.toHaveBeenCalled();
  });

  it("ends a flow whose completion arrived before the start reply seated it", async () => {
    // The tail opens BEFORE `providerAccount.login` is called — the registered ordering
    // — so a flow that finishes fast reports its completion while the start reply is
    // still travelling. The plane would otherwise seat an attempt that is already over
    // and hold the key until somebody pressed cancel.
    const { plane, onFlowSettled } = planeOverServedCalls();

    plane.start(RUNNING_ACCOUNT_ID);
    plane.noteLoginCompleted(SIGN_IN_ATTEMPT.attemptId);
    await crossMacrotaskBoundary();

    expect(plane.snapshot().flow.kind).toBe("ended");
    expect(onFlowSettled).toHaveBeenCalledTimes(1);
  });

  it("installs nothing once disposed", async () => {
    const { plane } = planeOverServedCalls();

    plane.start(RUNNING_ACCOUNT_ID);
    plane.dispose();
    await crossMacrotaskBoundary();

    expect(plane.snapshot().flow).toEqual({ kind: "starting", accountId: RUNNING_ACCOUNT_ID });
    plane.start(WAITING_ACCOUNT_ID);
    expect(plane.snapshot().refusalByAccountId.size).toBe(0);
  });
});
