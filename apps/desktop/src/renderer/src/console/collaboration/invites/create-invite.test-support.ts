// The cast every create-invite suite drives this one surface with.
//
// Hoisted on this package's second-use rule the moment a second suite needed it: the
// form's own cases and the link-retry cases beside them are two readings of one
// surface, and both need one minted invitation, one scripted mint, one bridge that
// serves the two growth reads the form takes, and one way of pressing send. A second
// copy of the token constant is two suites disagreeing about which credential is on
// screen; a second `bridgeFor` is two suites disagreeing about which reads a form
// takes at all.
//
// EVERY BRIDGE HERE IS THE REAL FIXTURE, so the create call is parsed against the
// registered `InviteCreate` / `InviteCreateResponse` shapes on its way out and back —
// a request this console could not actually send is refused by the call door rather
// than passing over a hand-built stub.

import { act, fireEvent } from "@testing-library/react";

import {
  fixtureBridgeWithGrowth,
  growthServing,
  unscriptedScenario,
  withDaemonCall,
  type BridgeUnderTest,
} from "../../bridge/fixture/call-plane/bridge.test-support.js";
import type { GrowthOutcome } from "../../bridge/index.js";
import type { ConsoleScenario } from "../../bridge/scenario-runtime/scenario.js";
import { crossMacrotaskBoundary } from "../../core/macrotask-boundary.test-support.js";
import { settle as settleReactWork } from "../../core/settle.test-support.js";
import { VIEWING_PARTICIPANT, invite } from "./sent-invites.test-support.js";

/** The invitation the scripted mint answers with. Branded UUID, like every wire id. */
export const MINTED_INVITE_ID: string = "019b7910-0007-7000-8000-000000000001";

/** A plausible `v4.local` blob. Never rendered on its own — only inside the link. */
export const MINTED_TOKEN: string = "v4.local.dGhpcy1pcy1ub3QtYS1yZWFsLXRva2Vu";

/** The host the scenario's node answers its control plane on. */
export const CONTROL_PLANE_HOST: string = "sidekicks.example";

/** Seven days past the scenario's own frozen start, which is the default expiry. */
export const DEFAULT_EXPIRY: string = "2026-01-08T10:05:00.000Z";

/** One day past it, which is the shortest the form offers. */
export const SHORT_EXPIRY: string = "2026-01-02T10:05:00.000Z";

/**
 * A scenario that answers the mint with the expiry the caller asked for.
 *
 * Computed rather than fixed, because the reveal renders the reply's OWN expiry: a
 * scenario answering one constant would let a case pass over a surface that showed
 * the value it had asked for rather than the one it got back.
 */
export function scenarioMinting(): ConsoleScenario {
  return {
    ...unscriptedScenario("collaboration-create-invite-test"),
    replies: [
      {
        call: "invite.create",
        resultFor: (request) => {
          const asked = request as { readonly expiresAt?: unknown };
          return {
            inviteId: MINTED_INVITE_ID,
            token: MINTED_TOKEN,
            expiresAt: typeof asked.expiresAt === "string" ? asked.expiresAt : DEFAULT_EXPIRY,
          };
        },
      },
    ],
  };
}

/** A scenario whose mint refuses with one registered wire code. */
export function scenarioRefusingMint(code: string, message: string): ConsoleScenario {
  return {
    ...unscriptedScenario("collaboration-create-invite-refused-test"),
    replies: [{ call: "invite.create", refusal: { code, message } }],
  };
}

/**
 * The real fixture bridge, with the two growth reads this form takes served, and the
 * record of what it was asked.
 *
 * Through the shared call arm rather than a spy on the namespace: the console has one
 * seam for observing what reached the daemon, and a surface's test standing in for a
 * surface goes through the same door a surface does.
 */
export function bridgeFor(
  scenario: ConsoleScenario,
  overrides: Parameters<typeof fixtureBridgeWithGrowth>[1] = {},
): BridgeUnderTest {
  return withDaemonCall(
    fixtureBridgeWithGrowth(scenario, {
      callerParticipantRead: growthServing({ participantId: VIEWING_PARTICIPANT }),
      controlPlaneHostRead: growthServing({ host: CONTROL_PLANE_HOST }),
      invitesList: growthServing([invite()]),
      ...overrides,
    }),
    // Every call is the scenario's own; this arm only records what went past.
    async (_recorded, passThrough) => await passThrough(),
  );
}

/**
 * The host read held open, with the means to answer it later.
 *
 * The window every case about the act's INTERIOR has to observe is the one between the
 * press and the composed link, and a read that answers immediately closes it before a
 * case can look. `settleable` in the coordinator's own suite is this shape for the
 * daemon arm; this is the growth arm's, hoisted the moment a second suite needed it —
 * one surface reads this operation and two suites drive it, the form's own cases and
 * the shell cases beside them.
 */
export function heldHostRead(): {
  readonly read: () => Promise<GrowthOutcome<{ readonly host: string }>>;
  readonly answer: () => void;
} {
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    read: async () => {
      await held;
      return { status: "served", value: { host: CONTROL_PLANE_HOST } };
    },
    answer: () => {
      release();
    },
  };
}

/** Let the reads, the mint, and the effects each schedules land. */
export async function settle(): Promise<void> {
  await settleReactWork();
}

export function sendControl(container: HTMLElement): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>(".meridian-invite-create__send");
}

/** Press the send control and let the mint and the host read that follows it settle. */
export async function pressSend(container: HTMLElement): Promise<void> {
  await act(async () => {
    sendControl(container)?.click();
    await crossMacrotaskBoundary();
  });
  await settle();
}

/** Choose one radio by the value the wire spells it with. */
export function choose(container: HTMLElement, value: string): void {
  const control = container.querySelector<HTMLElement>(`[value="${value}"]`);
  if (control === null) {
    throw new Error(`no choice for ${value}`);
  }
  fireEvent.click(control);
}

/** How many invitations actually reached the daemon. */
export function mintsReaching(calls: readonly { readonly method: string }[]): number {
  return calls.filter((recorded) => recorded.method === "invite.create").length;
}
