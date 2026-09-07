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
// The wire calls run against the real bridge — the fixture's growth port, which now
// SERVES both lease operations from the playing scenario's script. So there are two
// refusing bridges here rather than one, and the difference is the whole of what each
// drives: the terminal scenario scripts the contested take, so its refusal is the
// DAEMON's and carries a holder; the flagship scripts neither call, so its refusal is
// the fixture's own `reply-unscripted` — the port saying the scenario never answered.
// A hand-rolled stub would let either render pass against a shape the port does not
// produce.
//
// The lease STATE is a value here, built directly rather than folded from a
// scenario, because `lease-model.test.ts` already holds the fold to the wire and
// these suites' subject is what each state RENDERS. The viewer's identity is a value
// for the same reason: `terminal/pane/TerminalPane.test.tsx` drives the read that
// produces one, against the real port, and every case renders under a settled one so
// that the state it names is what it is about.

import { render, type RenderResult } from "@testing-library/react";

import { createFixtureBridge, type ConsoleBridge } from "../../bridge/index.js";
import type { CallerMembershipRoleResult } from "../../store/index.js";
import { FLAGSHIP_SCENARIO } from "../../bridge/scenarios/flagship.js";
import { TERMINAL_SCENARIO } from "../../bridge/scenarios/terminal.js";
import {
  leaseEventWithPayload,
  OTHER_PARTICIPANT,
  VIEWER_PARTICIPANT,
} from "./lease-model.test-support.js";
import { LeaseLine } from "./LeaseLine.js";
import type { TerminalParticipantMark } from "./participant-mark.js";
import type { TerminalViewerIdentity } from "./viewer-identity.js";
import { UNREAD_TERMINAL_LEASE, type TerminalLeaseState } from "./lease-model.js";
import type { TerminalLeaseTransition } from "./lease-transition.js";

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

/**
 * A bridge whose lease calls are SERVED and whose scenario scripts neither of them.
 *
 * The port's own refusal rather than a daemon's: the flagship models no shared shell,
 * so a take against it reaches the `reply-unscripted` arm — which is what a served
 * operation with nothing to answer from says, and the arm a surface has to render
 * without inventing a sentence for it.
 */
export function scriptlessLeaseBridge(): ConsoleBridge {
  return createFixtureBridge({ scenario: FLAGSHIP_SCENARIO });
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
        value: { controlHolder: VIEWER_PARTICIPANT },
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
 * The lease wire, with every claim held until a case settles it by name.
 *
 * A class rather than a factory returning one settle function, because the state IS
 * the point: the rebind cases need more than one call out at once — the session the
 * pane left and the session it moved to — and a fixture that only reached the newest
 * could not say which of them a settlement belonged to. A held promise is also the
 * only way to have a call genuinely still out across a rerender: the fixture port
 * answers on its own microtask, so it has already resolved by the time a rerender
 * can run.
 *
 * The calls REJECT rather than resolve, so a settlement carries the wire's own code
 * and a case can read exactly which session's answer reached the screen.
 */
export class HeldLeaseWire {
  /** What a daemon says when somebody else has the shell. The wire's own shape. */
  public static readonly LEASE_CONFLICT: { readonly code: string; readonly message: string } = {
    code: "terminal.lease_conflict",
    message: "Another participant holds the shell.",
  };

  readonly #heldSessionIds: string[] = [];
  readonly #heldRejectors: ((rejection: unknown) => void)[] = [];
  public readonly bridge: ConsoleBridge;

  public constructor() {
    const base = createFixtureBridge({ scenario: TERMINAL_SCENARIO });
    const hold = (request: { readonly sessionId: string }): Promise<never> => {
      this.#heldSessionIds.push(request.sessionId);
      return new Promise<never>((_resolve, reject) => {
        this.#heldRejectors.push(reject);
      });
    };
    this.bridge = {
      ...base,
      growth: {
        ...base.growth,
        terminalAcquireWriteLease: hold,
        terminalReleaseWriteLease: hold,
      },
    };
  }

  /** How many calls are out. The premise of every case that settles one. */
  public get heldCallCount(): number {
    return this.#heldRejectors.length;
  }

  /** The session a held call was made under, in the order the calls went out. */
  public sessionIdOfCall(callIndex: number): string {
    const sessionId = this.#heldSessionIds[callIndex];
    if (sessionId === undefined) {
      throw new Error(`no lease call number ${String(callIndex)} is out`);
    }
    return sessionId;
  }

  /** Settle one held call the way a lease conflict does. */
  public rejectCall(callIndex: number): void {
    const reject = this.#heldRejectors[callIndex];
    if (reject === undefined) {
      throw new Error(`no lease call number ${String(callIndex)} is out`);
    }
    reject(HeldLeaseWire.LEASE_CONFLICT);
  }
}

export function markFor(participantId: string): TerminalParticipantMark | undefined {
  return participantId === OTHER_PARTICIPANT
    ? { hueStep: 3, ringTreatment: "dashed", displayName: undefined }
    : undefined;
}

export function leaseState(overrides: Partial<TerminalLeaseState>): TerminalLeaseState {
  return { ...UNREAD_TERMINAL_LEASE, ...overrides };
}

/**
 * One folded transition, at the instant the event it was folded from carries.
 *
 * The instant comes off the family's own event builder rather than a template of its
 * own. The copy that stood here spelled `16:40:0${sequence}`, whose seconds field has
 * one digit — so a case reaching sequence 10 minted `16:40:010`, which is not an
 * instant, and `formatClockTime` answers an em dash for it. That failure is silent in
 * exactly the suite that would provoke it: a ledger driven to its thirty-two-row cap
 * renders a column of dashes where it should render orderable times. `eventOfKind` is
 * where this family already decided what an event's instant looks like, and the two
 * sibling builders in this directory were rebound onto it for this reason; a third
 * derivation beside them is the drift that repair exists to end.
 */
export function transitionAt(
  sequence: number,
  reason: TerminalLeaseTransition["reason"],
  overrides: Partial<TerminalLeaseTransition> = {},
): TerminalLeaseTransition {
  return {
    sequence,
    occurredAtIso: leaseEventWithPayload(sequence, undefined).occurredAt,
    reason,
    holderParticipantId: reason === "taken" ? OTHER_PARTICIPANT : null,
    previousHolderParticipantId: reason === "taken" ? null : OTHER_PARTICIPANT,
    actorId: OTHER_PARTICIPANT,
    ...overrides,
  };
}

/**
 * The identity every case below renders under unless it is about the other arms.
 *
 * Read, and read as the viewer: the claim control is gated on the identity having
 * landed, so a default of anything else would make every case in this file about the
 * withheld state instead of about the state it names.
 */
export const VIEWER_IDENTITY_READ: TerminalViewerIdentity = {
  status: "read",
  participantId: VIEWER_PARTICIPANT,
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
  participantId: VIEWER_PARTICIPANT,
  role: "collaborator",
};

export function renderLease(
  state: TerminalLeaseState,
  bridge: ConsoleBridge = refusingBridge(),
  viewerIdentity: TerminalViewerIdentity = VIEWER_IDENTITY_READ,
  callerRole: CallerMembershipRoleResult = CALLER_ROLE_COLLABORATOR,
  hasSteppableRun = true,
): RenderResult {
  return render(
    <LeaseLine
      bridge={bridge}
      sessionId={SESSION_ID}
      state={state}
      markFor={markFor}
      viewerIdentity={viewerIdentity}
      callerRole={callerRole}
      hasSteppableRun={hasSteppableRun}
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
