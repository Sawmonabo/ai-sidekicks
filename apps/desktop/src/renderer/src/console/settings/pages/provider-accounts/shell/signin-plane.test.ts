// One brokered sign-in at a time, and where the second press lands.
//
// THE CASES BELOW ARE THE PAGE'S CLAIM STATED AT THE PLANE. `AccountsShell.test.tsx`
// asserts that the control is disabled with its reason on screen; a control is a
// courtesy, and these cases assert what happens to a press it did not stop — a stale
// frame, a keyboard activation racing the commit that disabled it.
//
// EVERY CASE DRIVES THE REAL `SignInPlane` over the real account-plane calls. The
// single-flight guard under test is `store/generation-latch.ts`, reached exactly as
// the shipped module reaches it, so a case here fails if that register's refusal
// contract changes.

import { describe, expect, it, vi } from "vitest";

import type { ProviderAccountId } from "@ai-sidekicks/contracts";

import type { ConsoleBridge } from "../../../../bridge/index.js";
import { crossMacrotaskBoundary } from "../../../../core/macrotask-boundary.test-support.js";
import { bridgeAnswering, SIGN_IN_ATTEMPT } from "./account-plane-bridge.test-support.js";
import { cancelSignIn, startSignIn } from "./signin-flow.js";
import { SignInPlane, signInHeldSentence, signInPlaneHolder } from "./signin-plane.js";

const RUNNING_ACCOUNT_ID = "pa-0001" as ProviderAccountId;
const WAITING_ACCOUNT_ID = "pa-0002" as ProviderAccountId;

/**
 * A plane over one bridge, bound the way the shell binds it.
 *
 * The real `startSignIn` and `cancelSignIn` rather than stubs, so a case here drives
 * the outcome narrowing those functions perform as well as the plane's own rule.
 */
function planeOver(
  bridge: ConsoleBridge,
  onFlowSettled: () => void = (): void => undefined,
): SignInPlane {
  return new SignInPlane({
    startSignIn: async (accountId) => await startSignIn(bridge, accountId),
    cancelSignIn: async (attempt) => await cancelSignIn(bridge, attempt),
    onFlowSettled,
  });
}

/** A plane whose start is served and whose cancel is honoured. */
function planeOverServedCalls(): {
  readonly plane: SignInPlane;
  readonly onFlowSettled: ReturnType<typeof vi.fn>;
} {
  const onFlowSettled = vi.fn();
  const plane = planeOver(
    bridgeAnswering({
      login: { status: "served", value: SIGN_IN_ATTEMPT },
      cancel: { status: "served", value: { status: "cancelled" } },
    }),
    onFlowSettled,
  );
  return { plane, onFlowSettled };
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
    const bridge = bridgeAnswering({ login: { status: "served", value: SIGN_IN_ATTEMPT } });
    const plane = planeOver(bridge);

    plane.start(RUNNING_ACCOUNT_ID);
    plane.start(WAITING_ACCOUNT_ID);
    await crossMacrotaskBoundary();

    // The refusal is the console's own and the daemon was never asked, which is what
    // makes it arrive in the same tick as the press rather than a round trip later.
    expect(bridge.growth.providerAccountLogin).toHaveBeenCalledTimes(1);
    expect(bridge.growth.providerAccountLogin).toHaveBeenCalledWith({
      accountId: RUNNING_ACCOUNT_ID,
    });
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

  it("releases the plane when a start is refused by the daemon", async () => {
    // Nothing scripted, so the login verb answers the port's own unavailable refusal.
    const plane = planeOver(bridgeAnswering({}));

    plane.start(RUNNING_ACCOUNT_ID);
    await crossMacrotaskBoundary();

    expect(plane.snapshot().flow.kind).toBe("idle");
    expect(plane.snapshot().refusalByAccountId.has(RUNNING_ACCOUNT_ID)).toBe(true);
    expect(signInPlaneHolder(plane.snapshot())).toBeUndefined();

    // A start that never became a flow leaves nothing holding the plane, so the next
    // press is admitted rather than refused by a key nothing is using.
    plane.start(WAITING_ACCOUNT_ID);
    expect(plane.snapshot().flow).toEqual({ kind: "starting", accountId: WAITING_ACCOUNT_ID });
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
