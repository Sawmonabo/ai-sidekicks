// The goal card's shared mount, and the projections every case starts from.
//
// Not a test file — no `include` glob reaches a `.test-support.tsx`. It exists
// because the card's claims split across two suites once the seat and fold cases
// grew their own, and `apps/desktop` AGENTS.md hoists a helper on its second use:
// two copies of this mount is how one suite comes to assert against props the other
// no longer passes.

import { render } from "@testing-library/react";
import { vi } from "vitest";

import { SessionGoalCard } from "./SessionGoalCard.js";
import { refuse, type ConsoleRefusal } from "../../../core/index.js";
import type { ConsoleBridge } from "../../../bridge/index.js";
import { createFixture } from "../../../bridge/fixture/fixture-bridge.test-support.js";
import { type SessionGoalProjection } from "../../../bridge/index.js";

// The revisions below stand for whatever entry the fold read each projection from.
// The card compares them and never parses them, so what they say does not matter and
// whether two of them are the same does.
export const NO_GOAL: SessionGoalProjection = { status: "none", revision: "unset" };
export const A_GOAL: SessionGoalProjection = {
  status: "set",
  text: "Ship the approvals pane",
  revision: "o:1:node-alpha",
};

export const FIRST_SESSION_ID = "019b7a33-3300-75e5-8510-ada11a5a55b5";
export const SECOND_SESSION_ID = "019b7a33-3300-75e5-8510-ada11a5a55b6";

/**
 * A bridge this card only ever compares by identity.
 *
 * The card reads no member of it — the subject the editor is held under is the pair
 * `(bridge, sessionId)` and the comparison is `===` — and a fresh fixture per call is
 * what makes the identity cases mean anything: two of them stand for a replaced
 * window transport, which is the same shape the console really hands the card.
 *
 * The shipped fixture rather than an empty object cast to the type, because "reads no
 * member of it" is the claim under test rather than a licence: a card that started
 * reading one would get a real answer and be caught by what it renders, where a cast
 * stand-in fails on `undefined` somewhere that names neither the read nor the card.
 */
export function inertBridge(): ConsoleBridge {
  return createFixture().bridge;
}

export function renderCard(
  overrides: {
    goal?: SessionGoalProjection;
    canMutate?: boolean | undefined;
    authorizationRefusal?: ConsoleRefusal;
    isMutating?: boolean;
    onUpdate?: (text: string) => void;
    onClear?: () => void;
    bridge?: ConsoleBridge;
    sessionId?: string;
  } = {},
): {
  rerender: (goal: SessionGoalProjection) => void;
  /** Rebind the mounted card to another subject, as a pane rebind does. */
  rebindTo: (subject: { bridge?: ConsoleBridge; sessionId?: string }) => void;
} {
  const props = {
    bridge: overrides.bridge ?? inertBridge(),
    sessionId: overrides.sessionId ?? FIRST_SESSION_ID,
    goal: overrides.goal ?? NO_GOAL,
    canMutate: "canMutate" in overrides ? overrides.canMutate : true,
    authorizationRefusal: overrides.authorizationRefusal,
    isMutating: overrides.isMutating ?? false,
    refusal: undefined,
    onUpdate: overrides.onUpdate ?? vi.fn(),
    onClear: overrides.onClear ?? vi.fn(),
  };
  const view = render(<SessionGoalCard {...props} />);
  return {
    rerender: (goal) => {
      view.rerender(<SessionGoalCard {...props} goal={goal} />);
    },
    rebindTo: (subject) => {
      view.rerender(
        <SessionGoalCard
          {...props}
          bridge={subject.bridge ?? props.bridge}
          sessionId={subject.sessionId ?? props.sessionId}
        />,
      );
    },
  };
}

/**
 * A delivery refusal carrying the failed bindings the wire named.
 *
 * Built by spread rather than through the extension writer, which the core door does
 * not publish: the readers work structurally off the value, so this is the same shape
 * a rebuilt wire rejection produces — which is the point, since that rebuild is the
 * only producer of one in the running console.
 */
export function deliveryRefusalNaming(failedBindingIds: readonly string[]): ConsoleRefusal {
  const refusal: ConsoleRefusal & Record<string, unknown> = {
    ...refuse("session-goal", "session.goal_delivery_failed", "Delivery failed."),
    failedBindingIds,
  };
  return refusal;
}
