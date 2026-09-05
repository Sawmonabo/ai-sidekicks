// The goal mutation, and the session it is keyed to.
//
// Its own file because a mutation is not a read: it carries the session it mutates
// in the request rather than in the subscription, so the case that matters is a
// rebind between composing and sending — where a mutation keyed to the pane rather
// than to the request would set a goal on a session nobody was looking at.

import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  type ConsoleBridge,
  type GrowthOutcome,
  type GrowthUnavailable,
} from "../../../bridge/index.js";
import { createRefusingGrowthPort, growthUnavailable } from "../../../bridge/growth-port.js";
import { useSessionGoalMutation } from "../approvals-hooks.js";
import { SECOND_SESSION_ID, SESSION_ID } from "../approvals-hooks.test-support.js";

describe("the goal mutation is keyed to the session it mutates", () => {
  /**
   * A bridge whose goal mutation is settled by the test rather than by a timer.
   *
   * The port never rejects, so the settlement a case drives is a REFUSAL value and
   * not a thrown one — which is the seam's own shape and the reason the hook carries
   * no `catch`. Parked per session, because what every case here is about is which
   * session a settlement belongs to.
   */
  function deferredGoalBridge(): {
    readonly bridge: ConsoleBridge;
    readonly refuseFor: (sessionId: string, refusal: GrowthUnavailable) => void;
    readonly sessionIdsCalled: readonly string[];
  } {
    const settleBySessionId = new Map<string, (outcome: GrowthOutcome<undefined>) => void>();
    const sessionIdsCalled: string[] = [];
    const park = async (request: unknown): Promise<GrowthOutcome<undefined>> => {
      const { sessionId } = request as { readonly sessionId: string };
      sessionIdsCalled.push(sessionId);
      return new Promise<GrowthOutcome<undefined>>((resolve) => {
        settleBySessionId.set(sessionId, resolve);
      });
    };
    const bridge = {
      sidekicks: {
        daemon: {
          call: async (): Promise<unknown> => undefined,
          subscribe: () => () => undefined,
        },
      },
      growth: {
        ...createRefusingGrowthPort(),
        sessionGoalUpdate: park,
        sessionGoalClear: park,
      },
      source: "fixture",
      scenarioEngine: undefined,
    } as unknown as ConsoleBridge;
    return {
      bridge,
      refuseFor: (sessionId, refusal) => {
        const settle = settleBySessionId.get(sessionId);
        if (settle === undefined) {
          throw new Error(`no goal call is outstanding for ${sessionId}`);
        }
        settle(refusal);
      },
      sessionIdsCalled,
    };
  }

  type GoalMutation = ReturnType<typeof useSessionGoalMutation>;

  function GoalHarness(props: {
    readonly bridge: ConsoleBridge;
    readonly sessionId: string;
    readonly onMutation: (mutation: GoalMutation) => void;
  }): React.JSX.Element | null {
    const mutation = useSessionGoalMutation(props.bridge, props.sessionId);
    props.onMutation(mutation);
    return null;
  }

  /** Mount against one session, then rebind the mounted card to another. */
  function mountGoalCard(bridge: ConsoleBridge): {
    readonly latest: () => GoalMutation;
    readonly rebindTo: (sessionId: string) => void;
  } {
    let latest: GoalMutation | undefined;
    const onMutation = (mutation: GoalMutation): void => {
      latest = mutation;
    };
    const view = render(
      <GoalHarness bridge={bridge} sessionId={SESSION_ID} onMutation={onMutation} />,
    );
    return {
      latest: () => {
        if (latest === undefined) {
          throw new Error("the hook handed back no mutation");
        }
        return latest;
      },
      rebindTo: (sessionId) => {
        act(() => {
          view.rerender(
            <GoalHarness bridge={bridge} sessionId={sessionId} onMutation={onMutation} />,
          );
        });
      },
    };
  }

  it("frees the new session's controls while the old session's change is settling", () => {
    const { bridge, sessionIdsCalled } = deferredGoalBridge();
    const card = mountGoalCard(bridge);
    act(() => {
      card.latest().update("the first session's goal");
    });
    expect(card.latest().isMutating).toBe(true);

    card.rebindTo(SECOND_SESSION_ID);
    // The first session's call is still outstanding and this session has none, so
    // this session's controls are its own.
    expect(card.latest().isMutating).toBe(false);
    expect(card.latest().refusal).toBeUndefined();

    act(() => {
      card.latest().update("the second session's goal");
    });
    expect(sessionIdsCalled).toStrictEqual([SESSION_ID, SECOND_SESSION_ID]);
    expect(card.latest().refusal).toBeUndefined();
  });

  it("installs nothing from a refusal that answers a session the card left", async () => {
    const { bridge, refuseFor } = deferredGoalBridge();
    const card = mountGoalCard(bridge);
    act(() => {
      card.latest().update("the first session's goal");
    });
    card.rebindTo(SECOND_SESSION_ID);

    await act(async () => {
      refuseFor(SESSION_ID, growthUnavailable("sessionGoalUpdate"));
      await Promise.resolve();
    });
    // The refusal belongs to a session this card is no longer addressed to, so
    // rendering it here would put one session's refusal beside another's goal.
    expect(card.latest().refusal).toBeUndefined();
    expect(card.latest().isMutating).toBe(false);
  });

  it("keeps the pending reading across a re-render that changes no subject", () => {
    const { bridge } = deferredGoalBridge();
    const card = mountGoalCard(bridge);
    act(() => {
      card.latest().update("the first session's goal");
    });
    card.rebindTo(SESSION_ID);
    expect(card.latest().isMutating).toBe(true);
  });

  it("negative control: a second change to the SAME session is still refused", () => {
    // Without this, a latch that had simply stopped guarding anything would pass
    // every case above while sending two mutations for one session.
    const { bridge, sessionIdsCalled } = deferredGoalBridge();
    const card = mountGoalCard(bridge);
    act(() => {
      card.latest().update("the first goal");
    });
    act(() => {
      card.latest().update("a second goal, sent before the first landed");
    });
    expect(sessionIdsCalled).toStrictEqual([SESSION_ID]);
    expect(card.latest().refusal?.code).toBe("goal_mutation_in_flight");
  });
});
