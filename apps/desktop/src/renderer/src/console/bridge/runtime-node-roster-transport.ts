// The runtime-node seam's LIVE arms: one control-plane read, one daemon subscription.
//
// The vocabulary both of them speak — the registered procedure name, the presence
// event set, the refusal codes, the outcome types — is `runtime-node-roster.ts`
// beside this file, which also holds the fixture read. What is HERE is everything
// that touches a real transport, which is what makes this the module with the brand
// casts, the reply parse, and the rejection normalization in it.
//
// TWO BRAND CASTS, AND WHY THEY ARE HERE. `CpProcedure` and `DaemonEvent` are
// `never`-shaped Plan-007/Plan-008 brands that no string literal is assignable to, so
// every caller in this repository casts — the three shipped Tier-1 components and
// `seats/wire-access.ts` each carry one. This module is the `bridge/` family's single
// copy, and it narrows rather than erases: the procedure NAME and the event NAME stay
// `string` (the genuinely untypeable half) while the request is pinned to the
// contracts package's own type and the REPLY is parsed rather than claimed. When the
// brands narrow, the casts here and the family copy one level up are the sites that
// change.
//
// NEITHER ARM REJECTS. Both answer the seam's own two-arm outcome, and both build the
// refused arm through the console's ONE rejection normalizer, so a typed daemon
// refusal reaches the surface as its own registered code and its own retry bound
// rather than as the class name of whatever the transport threw.

import { RuntimeNodeRosterResponseSchema } from "@ai-sidekicks/contracts";
import type {
  RuntimeNodeRosterRequest,
  SessionId,
  SidekicksBridge,
  Unsubscribe,
} from "@ai-sidekicks/contracts";

import { normalizeWireRejection } from "../core/index.js";
import {
  RUNTIME_NODE_PRESENCE_EVENT_NAMES,
  RUNTIME_NODE_ROSTER_PROCEDURE,
  RUNTIME_NODE_ROSTER_REFUSAL_ORIGIN,
  RUNTIME_NODE_ROSTER_WIRE_REFUSAL_CODES,
  runtimeNodeRefusal,
  type RuntimeNodePresenceSubscription,
  type RuntimeNodeRefused,
  type RuntimeNodeRosterOutcome,
} from "./runtime-node-roster.js";

/**
 * Read the roster over the registered control-plane procedure. The live arm.
 *
 * The rejection is converted rather than propagated, and it goes through the
 * console's ONE normalizer to get there. `normalizeWireRejection` checks the
 * JSON-RPC arm FIRST — `JsonRpcRemoteError` carries the JSON-RPC numeric at `code`
 * and the project's dotted code at `data.type` — so a typed `runtimenode.*` or
 * `ratelimit.*` refusal reaches the surface as its own registered code, with the
 * `retryAfter` / `resetAt` bound the same envelope carries. A rejection naming no
 * code at all takes this seam's own `roster-read-failed`, which is a code the console
 * registers rather than whatever class the transport happened to throw.
 *
 * THE REPLY IS PARSED, NOT CAST. `RuntimeNodeRosterResponseSchema` is `.strict()` and
 * the co-located fixture suite already holds every scripted frame to it, which left
 * the LIVE wire as the one unchecked reading. A control plane one revision ahead that
 * renamed a member would reach the surface as `undefined` under a `served` status,
 * and the never-mask reading would silently stop distinguishing a degraded node while
 * reporting a successful read. An unreadable reply is therefore a refusal — the same
 * disposition `callDaemon` takes at its own door.
 */
export async function readRuntimeNodeRosterOverControlPlane(
  sidekicks: SidekicksBridge,
  request: RuntimeNodeRosterRequest,
): Promise<RuntimeNodeRosterOutcome> {
  // The reply is `unknown` on the way in, deliberately: the brand cast narrows the
  // procedure NAME and the request, and claiming the response type here would be the
  // cast this parse exists to retire.
  const callProcedure = sidekicks.controlPlane.call as unknown as (
    procedure: string,
    input: RuntimeNodeRosterRequest,
  ) => Promise<unknown>;
  try {
    const reply = await callProcedure(RUNTIME_NODE_ROSTER_PROCEDURE, request);
    const parsed = RuntimeNodeRosterResponseSchema.safeParse(reply);
    if (!parsed.success) {
      return runtimeNodeRefusal(
        "roster-reply-unreadable",
        "The control plane answered the runtime-node roster read with a reply this console cannot read.",
      );
    }
    return { status: "served", value: parsed.data };
  } catch (rejection: unknown) {
    return refusedFromRejection(rejection, {
      code: "roster-read-failed",
      detail:
        "The control plane did not answer the runtime-node roster read, and named no reason this console can report.",
    });
  }
}

/**
 * Subscribe to the presence transitions of one session, over `daemon.subscribe`.
 *
 * ONE subscription per registered name, because the wire takes one name per call
 * and there is no stream that projects the family. The returned handle releases
 * every one of them, so a caller cannot half-detach.
 *
 * THE SESSION FILTER FAILS OPEN, deliberately. `daemon.subscribe` carries no
 * session parameter, so the filter has to run at the delivery boundary — and the
 * only thing this module may read off an `unknown` is a member the contract
 * declares. The lifecycle payloads carry `sessionId`, and the fixture delivers the
 * beat envelope, which carries it too; so a delivery that NAMES a different session
 * is dropped, and one that names none is delivered. That direction is the safe one:
 * an extra signal costs one coalesced re-read, while a dropped signal leaves the
 * roster silently stale, which is the failure a live roster exists to prevent.
 */
export function subscribeRuntimeNodePresence(
  sidekicks: SidekicksBridge,
  sessionId: SessionId,
  onPresenceChange: () => void,
): RuntimeNodePresenceSubscription {
  const subscribeToEvent = sidekicks.daemon.subscribe as unknown as (
    eventName: string,
    handler: (payload: unknown) => void,
  ) => Unsubscribe;
  const taken: Unsubscribe[] = [];
  const releaseAll = (): void => {
    for (const unsubscribe of taken.splice(0, taken.length)) {
      unsubscribe();
    }
  };
  for (const eventName of RUNTIME_NODE_PRESENCE_EVENT_NAMES) {
    try {
      taken.push(
        subscribeToEvent(eventName, (payload: unknown) => {
          if (namesAnotherSession(payload, sessionId)) {
            return;
          }
          onPresenceChange();
        }),
      );
    } catch (rejection: unknown) {
      // ALL OR NOTHING. A subscription that covered three of the five registered
      // names would deliver some transitions and drop others, which reads as a
      // roster that updates sometimes — the hardest kind of staleness to notice.
      // So the ones already taken are released and the whole attempt refuses,
      // carrying the thrower's own name and sentence rather than a paraphrase.
      releaseAll();
      return refusedFromRejection(rejection, {
        code: "presence-subscribe-failed",
        detail:
          "The runtime-node presence stream did not open, and the daemon named no reason this console can report.",
      });
    }
  }
  return { status: "subscribed", unsubscribe: releaseAll };
}

/** Does a delivered payload name a session other than the subscribed one? */
function namesAnotherSession(delivered: unknown, sessionId: SessionId): boolean {
  if (typeof delivered !== "object" || delivered === null) {
    return false;
  }
  const { sessionId: deliveredSessionId } = delivered as { readonly sessionId?: unknown };
  return typeof deliveredSessionId === "string" && deliveredSessionId !== sessionId;
}

/**
 * The refusal the LIVE arms raise, carrying the refuser's own code verbatim.
 *
 * The `fallback` is a LAST RESORT and never a displacement: `normalizeWireRejection`
 * runs its typed arms first, so a rejection that named a code — a carried
 * `ConsoleRefusal`, a JSON-RPC `data.type`, a flat `{code, message}` envelope — keeps
 * it, and only a rejection that named none reaches this seam's own. The fallback is
 * held to the closed set above precisely because it is the one code this module
 * chooses, which makes a code it invents a compile error rather than a convention.
 */
function refusedFromRejection(
  rejection: unknown,
  fallback: {
    readonly code: (typeof RUNTIME_NODE_ROSTER_WIRE_REFUSAL_CODES)[number];
    readonly detail: string;
  },
): RuntimeNodeRefused {
  return {
    ...normalizeWireRejection(RUNTIME_NODE_ROSTER_REFUSAL_ORIGIN, rejection, fallback),
    status: "refused",
  };
}
