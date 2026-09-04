// What every `LeaseLine` suite needs before it asserts anything.
//
// The line's cases are split by responsibility — the holder projection, the claim
// call, the transition ledger, the viewer-identity gate, and the role gate each have
// their own module — and all five render the same component against the same cast,
// the same session ids, and the same bridges. Those live here rather than in
// whichever file was written first, on this package's rule that shared scaffolding
// lives once: a second copy of `servingBridge` would be a second answer to "what
// does a SERVED lease reply look like", and the two would drift the first time the
// registered reply grew a member.
//
// The wire calls run against the real bridge — the fixture's growth port, which
// refuses `terminalAcquireWriteLease` by name because `Plan-023 §Console growth
// slate` has not registered it. A hand-rolled stub would let the refusal render
// pass against a shape the port does not produce.
//
// The lease STATE is a value here, built directly rather than folded from a
// scenario, because `lease-model.test.ts` already holds the fold to the wire and
// these suites' subject is what each state RENDERS. The VIEWER's identity is a value
// for the same reason: `panes/terminal/TerminalPane.test.tsx` drives the read that
// produces one, against the real port, and every case renders under a settled one so
// that the state it names is what it is about.

import { render, type RenderResult } from "@testing-library/react";

import { createFixtureBridge, type ConsoleBridge } from "../bridge/index.js";
import type { CallerMembershipRoleResult } from "../store/index.js";
import { FLAGSHIP_SCENARIO } from "../bridge/scenarios/flagship.js";
import { TERMINAL_SCENARIO, TERMINAL_SCENARIO_CAST } from "../bridge/scenarios/terminal.js";
import { LeaseLine, type TerminalParticipantMark } from "./LeaseLine.js";
import type { TerminalViewerIdentity } from "./viewer-identity.js";
import { UNREAD_TERMINAL_LEASE, type TerminalLeaseState } from "./lease-model.js";
import type { TerminalLeaseTransition } from "./lease-transition.js";

/**
 * The holder and the viewer, read off the scenario's join log rather than invented.
 *
 * `lease-model.test.ts`'s reason: a readable placeholder here would be a participant
 * id no daemon could emit, sitting beside a fixture whose own beats are wire-declared
 * UUIDs. The cast names the role each one plays, which an index into the join log
 * does not. The line renders the id verbatim when no roster supplies a name, so the
 * cases below assert against the same string the pane would show.
 */
export const VIEWER: string = TERMINAL_SCENARIO_CAST.owner;
export const HOLDER: string = TERMINAL_SCENARIO_CAST.collaborator;

/**
 * The lease's own subject on the wire, read off the scenario rather than invented.
 *
 * `session.takeControl` and `session.releaseControl` both take `{ sessionId }`, and
 * the scenario's session id is a wire-declared UUID — so the request the cases below
 * assert on is the one a daemon would actually be handed.
 */
export const SESSION_ID: string = TERMINAL_SCENARIO.sessionId;

/**
 * The other session this window can be rebound to, read off another scenario.
 *
 * A second wire-declared id rather than a readable placeholder, for the reason the
 * first one is read off a scenario: the claim's whole subject is the session it was
 * made under, so the id it is compared against has to be one a daemon could emit.
 */
export const OTHER_SESSION_ID: string = FLAGSHIP_SCENARIO.sessionId;

export function refusingBridge(): ConsoleBridge {
  return createFixtureBridge({ scenario: TERMINAL_SCENARIO });
}

/** A bridge whose lease calls are SERVED, to prove the holder still does not move. */
export function servingBridge(): ConsoleBridge {
  const base = createFixtureBridge({ scenario: TERMINAL_SCENARIO });
  return {
    ...base,
    growth: {
      ...base.growth,
      // The registered replies, verbatim: a take answers with the caller as
      // `controlHolder`, a release answers with the freed lease.
      terminalAcquireWriteLease: async () => ({
        status: "served" as const,
        value: { controlHolder: VIEWER },
      }),
      terminalReleaseWriteLease: async () => ({
        status: "served" as const,
        value: { controlHolder: null },
      }),
    },
  };
}

/**
 * A bridge whose lease calls REJECT with the wire's own `{ code, message }`.
 *
 * The shape a rejected registered call actually carries across the preload
 * boundary (`src/shared/wire-errors.ts` owns it, for every renderer surface). The
 * port ANSWERS a refusal, so a rejection is the bridge itself failing — and a
 * daemon that refused a claim because somebody else holds the shell said so with a
 * code the person can act on.
 */
export function bridgeRejectingWith(rejection: unknown): ConsoleBridge {
  const base = createFixtureBridge({ scenario: TERMINAL_SCENARIO });
  return {
    ...base,
    growth: {
      ...base.growth,
      terminalAcquireWriteLease: () => Promise.reject(rejection),
      terminalReleaseWriteLease: () => Promise.reject(rejection),
    },
  };
}

/**
 * A bridge whose claim never settles until the case says so.
 *
 * The rebind cases need a call that is genuinely still out across a prop change, and
 * a promise the test holds the settlement of is the only way to have one: a fixture
 * that answers on its own microtask has already resolved by the time a rerender can
 * run. It rejects rather than resolves, so the settlement carries the wire's own code
 * and a case can say exactly which session's answer reached the screen.
 */
export function bridgeWithUnsettledClaim(): {
  readonly bridge: ConsoleBridge;
  readonly rejectTheHeldClaim: () => void;
} {
  const base = createFixtureBridge({ scenario: TERMINAL_SCENARIO });
  let rejectHeldClaim: ((rejection: unknown) => void) | undefined;
  return {
    bridge: {
      ...base,
      growth: {
        ...base.growth,
        terminalAcquireWriteLease: () =>
          new Promise<never>((_resolve, reject) => {
            rejectHeldClaim = reject;
          }),
      },
    },
    rejectTheHeldClaim: () => {
      rejectHeldClaim?.({
        code: "terminal.lease_conflict",
        message: "Another participant holds the shell.",
      });
    },
  };
}

export function markFor(participantId: string): TerminalParticipantMark | undefined {
  return participantId === HOLDER
    ? { hueStep: 3, ringTreatment: "dashed", displayName: undefined }
    : undefined;
}

export function leaseState(overrides: Partial<TerminalLeaseState>): TerminalLeaseState {
  return { ...UNREAD_TERMINAL_LEASE, ...overrides };
}

export function transitionAt(
  sequence: number,
  reason: TerminalLeaseTransition["reason"],
  overrides: Partial<TerminalLeaseTransition> = {},
): TerminalLeaseTransition {
  return {
    sequence,
    occurredAtIso: `2026-01-01T16:40:0${String(sequence)}.000Z`,
    reason,
    holderParticipantId: reason === "taken" ? HOLDER : null,
    previousHolderParticipantId: reason === "taken" ? null : HOLDER,
    actorId: HOLDER,
    ...overrides,
  };
}

/**
 * The identity every case below renders under unless it is about the other arms.
 *
 * Read, and read as the VIEWER: the claim control is gated on the identity having
 * landed, so a default of anything else would make every case in this file about the
 * withheld state instead of about the state it names.
 */
export const VIEWER_IDENTITY_READ: TerminalViewerIdentity = {
  status: "read",
  participantId: VIEWER,
};

/**
 * The role every case below renders under unless it is about the acquisition gate.
 *
 * A collaborator rather than an owner, and read: taking the shell is open to both, so
 * a case about a HOLDING renders the control it names, and the one role the gate
 * refuses is exercised where it belongs.
 */
export const CALLER_ROLE_COLLABORATOR: CallerMembershipRoleResult = {
  status: "read",
  participantId: VIEWER,
  role: "collaborator",
};

export function renderLease(
  state: TerminalLeaseState,
  bridge: ConsoleBridge = refusingBridge(),
  viewerIdentity: TerminalViewerIdentity = VIEWER_IDENTITY_READ,
  callerRole: CallerMembershipRoleResult = CALLER_ROLE_COLLABORATOR,
): RenderResult {
  return render(
    <LeaseLine
      bridge={bridge}
      sessionId={SESSION_ID}
      state={state}
      markFor={markFor}
      viewerIdentity={viewerIdentity}
      callerRole={callerRole}
    />,
  );
}

/** The single affordance 8.8 puts in the header, as something a test can press. */
export function claimControl(container: HTMLElement): HTMLButtonElement {
  const control = container.querySelector(".meridian-lease-line__claim");
  if (!(control instanceof HTMLButtonElement)) {
    throw new Error("the lease line rendered no claim control");
  }
  return control;
}

/**
 * The member names of the one request a lease spy was handed.
 *
 * Keys rather than the whole value: the claim is the SHAPE, and a value comparison
 * alone passes for a request that carries the session under the right name and a
 * pane id beside it — which is the state the strict schema refuses.
 */
export function requestShapeOf(spy: {
  readonly mock: { readonly calls: readonly unknown[][] };
}): string[] {
  const request = spy.mock.calls[0]?.[0];
  if (typeof request !== "object" || request === null) {
    throw new Error("the lease call was made with no request object");
  }
  return Object.keys(request).sort();
}

export function disclosureControl(container: HTMLElement): HTMLButtonElement {
  const control = container.querySelector(".meridian-lease-line__disclosure");
  if (!(control instanceof HTMLButtonElement)) {
    throw new Error("the lease line rendered no transition disclosure");
  }
  return control;
}
