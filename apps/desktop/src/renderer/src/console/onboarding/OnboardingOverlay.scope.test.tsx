// Which account the walkthrough is about, on the FIRST frame of every activation.
//
// THE DEFECT. The readiness scope was installed from a passive effect inside the
// walkthrough, and a passive effect runs after the commit that scheduled it. Reopening
// at a different account therefore painted one committed frame carrying the PREVIOUS
// account's readiness snapshot under the new account's activation — the previous
// account's rows, its per-provider acts still pressable — and an interaction reaching
// that frame acted on a credential home nobody had asked about. Nothing on screen said
// which account was being described, so the frame is indistinguishable by eye.
//
// SO THE CLAIM IS ABOUT A FRAME AND NOT ABOUT A SETTLED TREE. `act` flushes passive
// effects before it returns, so an assertion taken after a re-activation sees the tree
// the effect already corrected — which is why this drives `CommittedFrameRecorder`,
// whose `Profiler` fires during the commit phase and before any passive effect. That
// instrument is the whole reason this suite is separate from the overlay's others.
//
// AND THE SECOND HALF IS WHERE THE ACTS POINT. A frame that renders nothing is not the
// claim: what matters is that the model is addressed at the new account by then, so
// the read that follows carries THAT account and a re-check dispatched from the frame
// would reach it. Both are asserted, because either alone passes over a bug.

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { createFixtureBridge, readProviderAccountId } from "../bridge/index.js";
import { withDaemonCall } from "../bridge/fixture/call-plane/bridge.test-support.js";
import { ONBOARDING_SCENARIO } from "../bridge/scenarios/onboarding.js";
import { CommittedFrameRecorder } from "../core/committed-frame.test-support.js";
import { crossMacrotaskBoundary } from "../core/macrotask-boundary.test-support.js";
import { FrameStore } from "../store/index.js";
import { onboardingActivation } from "./onboarding-activation.js";
import { OnboardingOverlay } from "./OnboardingOverlay.js";
import { contextOver, unregisterOnboardingCommands } from "./OnboardingOverlay.test-support.js";

/** The readiness read every activation puts, whichever account it is scoped to. */
const READINESS_CALL = "providerAccount.list";

/** The two accounts the shipped onboarding scenario registers, in its own words. */
const CODEX_ACCOUNT = "019b78c9-0a80-7c31-8110-cca0117a3302";
const CLAUDE_ACCOUNT = "019b78c9-0a80-7c31-8110-cca0117a3303";

/** What the step renders while it has asked and has not been answered. */
const ZERO_STATE_TITLE = "Reading what this node can run";

/** What the step renders once a projection has landed — one row per selected provider. */
const SETTLED_ROW_LABEL = "Work subscription";

/** One call as the bridge helper recorded it. */
interface RecordedCall {
  readonly method: string;
  readonly params: unknown;
}

/**
 * The account each readiness read named, in order.
 *
 * The scope reaches the wire as `accountId` and an unscoped read omits it, so an
 * `undefined` here is a read that widened to the provider default — which is what a
 * model addressed at nothing would put, and a thing this suite has to be able to see.
 */
function readScopes(calls: readonly RecordedCall[]): readonly (string | undefined)[] {
  return calls
    .filter((call) => call.method === READINESS_CALL)
    .map((call) => (call.params as { readonly accountId?: string }).accountId);
}

/** Raise one activation and let the walkthrough's own opening reads settle. */
async function activateAtAccount(accountId: string): Promise<void> {
  await act(async () => {
    onboardingActivation.request({
      openAtStep: "providers",
      accountScope: readProviderAccountId(accountId),
    });
    await crossMacrotaskBoundary();
  });
  await act(async () => {
    await crossMacrotaskBoundary();
  });
}

afterEach(() => {
  cleanup();
  unregisterOnboardingCommands();
});

describe("reopening the walkthrough at a different account", () => {
  it("commits no frame carrying the previous account's readiness, and reads the new one", async () => {
    const committedFrames: string[] = [];
    const held = withDaemonCall(
      createFixtureBridge({ scenario: ONBOARDING_SCENARIO }),
      async (_call, passThrough) => await passThrough(),
    );
    render(
      <CommittedFrameRecorder
        id="onboarding-scope"
        onFrame={(committedText) => {
          committedFrames.push(committedText);
        }}
      >
        <OnboardingOverlay context={contextOver(held.bridge, new FrameStore())} />
      </CommittedFrameRecorder>,
    );
    await act(async () => {
      await crossMacrotaskBoundary();
    });

    await activateAtAccount(CODEX_ACCOUNT);
    // The premise, asserted rather than assumed: the first activation settled, so
    // there IS a previous account's snapshot for the second one to leak.
    expect(document.body.textContent).toContain(SETTLED_ROW_LABEL);
    expect(readScopes(held.calls)).toStrictEqual([CODEX_ACCOUNT]);

    const framesBeforeReopening = committedFrames.length;
    await activateAtAccount(CLAUDE_ACCOUNT);

    // Every frame the reopening painted, in order. The first of them is the one the
    // effect used to arrive too late for.
    const framesAfterReopening = committedFrames.slice(framesBeforeReopening);
    expect(framesAfterReopening.length).toBeGreaterThan(0);
    expect(framesAfterReopening[0]).toContain(ZERO_STATE_TITLE);
    expect(framesAfterReopening[0]).not.toContain(SETTLED_ROW_LABEL);

    // And the model was pointing at the new account by then, so what the frame offers
    // reaches that account rather than the one it replaced.
    expect(readScopes(held.calls)).toStrictEqual([CODEX_ACCOUNT, CLAUDE_ACCOUNT]);
    expect(document.body.textContent).toContain(SETTLED_ROW_LABEL);
  });

  it("negative control: reopening at the SAME account keeps its settled reading", async () => {
    // Without this the case above would pass over an overlay that cleared the reading
    // on every activation whatever its scope — a walkthrough that re-reads from
    // nothing each time it is reopened, which is a different defect and just as real.
    // `addressAt` answers this itself, and the case proves the overlay routes through
    // it rather than clearing on its own.
    const committedFrames: string[] = [];
    const held = withDaemonCall(
      createFixtureBridge({ scenario: ONBOARDING_SCENARIO }),
      async (_call, passThrough) => await passThrough(),
    );
    render(
      <CommittedFrameRecorder
        id="onboarding-scope-same"
        onFrame={(committedText) => {
          committedFrames.push(committedText);
        }}
      >
        <OnboardingOverlay context={contextOver(held.bridge, new FrameStore())} />
      </CommittedFrameRecorder>,
    );
    await act(async () => {
      await crossMacrotaskBoundary();
    });

    await activateAtAccount(CODEX_ACCOUNT);
    expect(document.body.textContent).toContain(SETTLED_ROW_LABEL);

    const framesBeforeReopening = committedFrames.length;
    await activateAtAccount(CODEX_ACCOUNT);

    const framesAfterReopening = committedFrames.slice(framesBeforeReopening);
    expect(framesAfterReopening.length).toBeGreaterThan(0);
    expect(framesAfterReopening[0]).toContain(SETTLED_ROW_LABEL);
  });
});
