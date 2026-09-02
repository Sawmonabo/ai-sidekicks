// The compaction call's own state machine, kept out of the control that renders it.
//
// The rule the design fixes is narrow and easy to break by accident: "one call per
// explicit request; the in-progress state clears when the call settles in EVERY
// arm". A control that held its own boolean would clear it on the arm the author
// remembered and leave the button spinning forever on the one they did not — and
// the arm nobody remembers is the rejection, which is exactly the arm a person
// meets when the driver cannot compact at all.
//
// So settlement is total here by construction: one `finally`-shaped resolution path
// that every outcome flows through, and a single-flight latch that makes a second
// press while a call is in flight a no-op rather than a second call.
//
// WHAT IS NEVER TREATED AS A COMPACTION. The reply is evidence the REQUEST settled,
// never evidence the context was compacted — both provider mechanisms answer before
// the work is done, and the completed state is the `usage.context_compacted` row
// alone. This module produces no such row and reads none; it reports what the call
// answered and stops there.

import { useCallback, useEffect, useRef, useState } from "react";
import { DriverCompactionResultSchema, type DriverCompactionResult } from "@ai-sidekicks/contracts";
import { normalizeWireRejection } from "../../../../../shared/wire-errors.js";
import { refuse, type ConsoleRefusal } from "../../../console/core/index.js";
import {
  COMPACT_CONTEXT_METHOD,
  callDaemon,
  type ConsoleBridge,
} from "../../../console/bridge/index.js";

/** The subsystem name every refusal this module raises carries. */
export const COMPACTION_REFUSAL_ORIGIN = "composer-compaction";

/**
 * Why the console refused to render the reply as a settlement.
 *
 * One code, and a closed set so a second is a decision rather than a free string.
 * It is raised only for a reply that does not parse as the registered result — a
 * daemon-composed shape the console has no reading for, which is a composition bug
 * and not a user-facing outcome.
 */
export const COMPACTION_REFUSAL_CODES = ["reply-unreadable"] as const;

/** One composer-side compaction refusal code. Derived, declared once. */
export type CompactionRefusalCode = (typeof COMPACTION_REFUSAL_CODES)[number];

/**
 * Where a compaction request has got to.
 *
 * `rejected` is the wire's own refusal envelope — `driver.capability_unsupported`,
 * `session.not_found`, and every other code the daemon may answer with — rendered
 * verbatim rather than mapped onto one of the result union's reasons, which name
 * settlements the daemon reached and this one never did.
 */
export type CompactionDispatchState =
  | { readonly phase: "idle" }
  | { readonly phase: "dispatching" }
  | { readonly phase: "settled"; readonly result: DriverCompactionResult }
  | { readonly phase: "rejected"; readonly refusal: ConsoleRefusal };

/** What the control is handed: the current state and the one act it may perform. */
export interface CompactionDispatch {
  readonly state: CompactionDispatchState;
  /** Dispatch one compaction for one run. A no-op while a call is in flight. */
  readonly requestCompaction: (targetRunId: string) => void;
}

const IDLE: CompactionDispatchState = { phase: "idle" };

/**
 * Drive one compaction request.
 *
 * The latch is a ref rather than state on purpose: it has to be readable and
 * writable in the same tick the click handler runs, and a state read inside that
 * handler would see the value from the render that produced it — so two clicks
 * inside one frame would both see `idle` and both dispatch.
 */
export function useCompactionDispatch(
  bridge: ConsoleBridge,
  sessionId: string,
): CompactionDispatch {
  const [state, setState] = useState<CompactionDispatchState>(IDLE);
  const isInFlight = useRef(false);
  const isMounted = useRef(true);

  useEffect(() => {
    isMounted.current = true;
    return () => {
      // A settle that lands after the composer unmounted has nowhere to go. The
      // latch is cleared with it so a remount starts idle rather than wedged.
      isMounted.current = false;
      isInFlight.current = false;
    };
  }, []);

  const requestCompaction = useCallback(
    (targetRunId: string) => {
      if (isInFlight.current) {
        return;
      }
      isInFlight.current = true;
      setState({ phase: "dispatching" });
      void settleCompaction(bridge, sessionId, targetRunId).then((settled) => {
        isInFlight.current = false;
        if (isMounted.current) {
          setState(settled);
        }
      });
    },
    [bridge, sessionId],
  );

  return { state, requestCompaction };
}

/**
 * One request, resolved into exactly one settled state.
 *
 * Returns rather than throws, and returns on every path — which is what makes the
 * "clears in every arm" guarantee structural instead of a promise the caller keeps.
 */
export async function settleCompaction(
  bridge: ConsoleBridge,
  sessionId: string,
  targetRunId: string,
): Promise<CompactionDispatchState> {
  try {
    const reply = await callDaemon(bridge, COMPACT_CONTEXT_METHOD, {
      sessionId,
      runId: targetRunId,
    });
    const parsed = DriverCompactionResultSchema.safeParse(reply);
    if (!parsed.success) {
      return {
        phase: "rejected",
        refusal: unreadableReply(),
      };
    }
    return { phase: "settled", result: parsed.data };
  } catch (rejection) {
    const wireError = normalizeWireRejection(rejection, { total: true });
    return {
      phase: "rejected",
      // `Error.name` carries the wire code when the rejection was a typed envelope
      // — that is what `normalizeWireRejection` puts there — so the refusal renders
      // `driver.capability_unsupported: …` rather than a class name nobody can
      // search for. The message is the daemon's own and is never reworded.
      refusal: refuse(COMPACTION_REFUSAL_ORIGIN, wireError.name, wireError.message),
    };
  }
}

function unreadableReply(): ConsoleRefusal {
  const code: CompactionRefusalCode = "reply-unreadable";
  return refuse(
    COMPACTION_REFUSAL_ORIGIN,
    code,
    "The compaction reply did not match the registered result shape, so the console did not read a settlement from it.",
  );
}
