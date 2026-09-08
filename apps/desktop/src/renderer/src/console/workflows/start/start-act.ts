// Starting one run from the picker, and what the picker knows about that act afterwards.
//
// ONE ACT AT A TIME, HELD AGAINST THE SESSION IT WAS MADE IN. A menu is one control
// surface: two starts in flight at once is two answers arriving into one line of chrome
// with nothing saying which is which. So the act is a single value, and it is held
// through the console's own subject-scoped holder rather than in a plain state cell —
// a composer re-addressed to another session must not carry the previous session's
// receipt or its refusal into the new one.
//
// THE PIN IS THE ENTRY'S OWN. A start is against a version, and the enumeration is what
// says which version a definition's name is at; composing one here would be this surface
// choosing a version nobody pinned.
//
// THE CHANNEL TRAVELS AS PROVENANCE AND IS NEVER TYPED BY ANYBODY. A composer addressed
// within a channel is a chat-borne start and says so; a composer addressed at a running
// turn carries none rather than a guessed one. Whether the starter is a member of that
// channel is the daemon's to validate, and this surface neither pre-empts nor re-derives
// it.
//
// EVERY REFUSAL IS CARRIED WHOLE, AND THE DAEMON'S OWN WORD IS THE ONE CARRIED. A port
// refusal has two arms and they put the readable code in two different places: the port
// answering for itself puts its own vocabulary on `code`, and a CALL that rejected puts
// `call-rejected` there and the daemon's envelope on `cause`. `workflow.start_denied` is
// the daemon's word, so a surface reading `code` alone would render `call-rejected` for
// exactly the refusal this path exists to surface — the defect `growth-outcome.ts`
// records, where one surface said `call-rejected` and its sibling said the daemon's code
// for the same failure. So the reading is resolved once, here, and the render is handed
// the pair rather than the union.
//
// AND ONE START REACHES THE DAEMON PER INTENDED ACT, WHICH THE HELD `act` CANNOT DECIDE.
// Publishing `starting` is what a LATER render reads; the value a press handler reads is
// the one from the render that produced it, so a double-click — or a press on one row
// followed by a press on another before the first answers — finds the picker idle twice
// and starts two runs, of which the shared `act` then shows whichever reply lands last.
// The guard is therefore taken at dispatch, from `store/generation-latch.ts`, which is
// the console's one register for exactly this and the mechanism every other act in this
// family already takes. The key is released on every settlement — served, refused, and a
// call that threw instead of answering — because a key held for the life of the port
// would leave the picker permanently unable to start anything.
//
// ONE KEY FOR THE WHOLE MENU, CARRYING THE SESSION. The picker holds ONE act, so a
// second start in flight would be a second answer arriving into one line of chrome with
// nothing saying which is which — the rule is one start at a time across every row, and a
// caller whose rule is that states it by claiming one key. The session is IN that key
// because this composer is re-addressed in place: an outstanding start must not refuse
// the first press of the session that replaced it.
//
// A REFUSED SECOND PRESS PUBLISHES NOTHING, AND THAT IS THE HONEST ANSWER RATHER THAN A
// SWALLOWED ONE. The act is one value: a refusal written into it would erase the only
// true thing on screen — that a run is starting, and which one — and, because the rows
// are disabled on exactly that reading, would offer them again while the first start was
// still outstanding. What the second press asked for is already happening and already
// named; the surface says so, once, beside controls it has closed.

import { useCallback } from "react";

import {
  settleGrowthRead,
  type GrowthPort,
  type GrowthUnavailable,
  type SettledReadRefusal,
} from "../../bridge/index.js";
import {
  useGenerationLatch,
  useSubjectScopedState,
  type GenerationClaim,
  type SubjectScopedPublish,
} from "../../store/index.js";
import type { WorkflowDefinitionRow } from "../definitions/definition-rows.js";

/** What the picker knows about the start it last asked for. */
export type WorkflowStartAct =
  | { readonly status: "idle" }
  | {
      readonly status: "starting";
      readonly definitionId: string;
      /** Named, because the rows are closed while this is true and one of them is why. */
      readonly definitionName: string;
    }
  | {
      readonly status: "started";
      readonly definitionId: string;
      readonly definitionName: string;
      readonly workflowRunId: string;
    }
  | {
      readonly status: "refused";
      readonly definitionId: string;
      /** The refusing wire's own code — the daemon's where the seam recovered one. */
      readonly code: string;
      /** That refusal's sentence, verbatim and never paraphrased. */
      readonly detail: string;
    };

/** Nobody has pressed anything yet, which is where every session's menu opens. */
const IDLE: WorkflowStartAct = { status: "idle" };

/** The act, and the one thing a row can ask for. */
export interface WorkflowStartDispatch {
  readonly act: WorkflowStartAct;
  readonly start: (definition: WorkflowDefinitionRow) => void;
}

/** What a start is addressed by, all of it the composer's own. */
export interface WorkflowStartAddress {
  readonly growth: GrowthPort;
  /** The session the run starts in, or nothing where this composer has none. */
  readonly sessionId: string | undefined;
  /** The originating channel of a chat-borne start. Absent everywhere else. */
  readonly channelId: string | undefined;
}

/**
 * Hold the picker's one start act.
 *
 * Keyed on the port AND the session, which is the pair every read on this seam is held
 * against: the fixture's scenario switch replaces the bridge and keeps the session id, so
 * a session-only holder would carry the previous scenario's receipt into the next one.
 */
export function useWorkflowStartAct(address: WorkflowStartAddress): WorkflowStartDispatch {
  const { growth, sessionId, channelId } = address;
  const latch = useGenerationLatch();
  const { value: act, publish } = useSubjectScopedState<WorkflowStartAct>(
    growth,
    sessionId,
    () => IDLE,
  );

  const start = useCallback(
    (definition: WorkflowDefinitionRow) => {
      if (sessionId === undefined) {
        return;
      }
      // Claimed BEFORE anything is published, and in the same tick as the press: the
      // claim both decides and takes, so no second press can pass between the two.
      const claim = latch.claim(growth, startKey(sessionId));
      if (claim === undefined) {
        return;
      }
      publish({
        status: "starting",
        definitionId: definition.id,
        definitionName: definition.name,
      });
      void dispatchStart({ growth, sessionId, channelId, definition, claim, publish });
    },
    [growth, sessionId, channelId, latch, publish],
  );

  return { act, start };
}

/**
 * The one key the picker's start is held under.
 *
 * The session and not the definition, because the rule is one start at a time across
 * every row: the menu shows one act, so two in flight would be two answers with nothing
 * saying which line of chrome belongs to which. The session is in it because a composer
 * is re-addressed in place and one session's outstanding start must not refuse the next
 * session's first press.
 */
function startKey(sessionId: string): string {
  return `workflow-start:${sessionId}`;
}

/** Everything one dispatch needs beyond the call it is about to put. */
interface StartDispatchRuntime {
  readonly growth: GrowthPort;
  readonly sessionId: string;
  readonly channelId: string | undefined;
  readonly definition: WorkflowDefinitionRow;
  readonly claim: GenerationClaim;
  readonly publish: SubjectScopedPublish<WorkflowStartAct>;
}

/**
 * Put the start and settle whatever comes back.
 *
 * The call is INSIDE the `try`, so the key goes back on every exit a dispatch has: an
 * answer, a refusal the seam normalized, a rejection, and a publish that threw on the way
 * out. Written as its own function rather than inline for exactly that reason — a
 * `.finally` hung off the settlement would not cover a call that threw before there was a
 * promise to hang it on.
 */
async function dispatchStart(runtime: StartDispatchRuntime): Promise<void> {
  const { growth, sessionId, channelId, definition, claim, publish } = runtime;
  try {
    const outcome = await settleGrowthRead(
      growth.workflowRunStart({
        workflowVersionId: definition.latestWorkflowVersionId,
        sessionId,
        ...(channelId === undefined ? {} : { channelId }),
      }),
    );
    // Published through the holder's own handle, which carries the addressing it was
    // captured under: an answer arriving after the composer moved to another session
    // writes nowhere rather than reporting one session's run under another's menu. The
    // claim's own `settle` is the other guard — it asks whether this round is still the
    // live one, which a teardown retires.
    claim.settle(() => {
      publish(
        outcome.status === "served"
          ? {
              status: "started",
              definitionId: definition.id,
              definitionName: definition.name,
              workflowRunId: outcome.value.workflowRunId,
            }
          : { status: "refused", definitionId: definition.id, ...refusalReading(outcome) },
      );
    });
  } finally {
    claim.release();
  }
}

/**
 * Which code and sentence a refusal actually says, across the port's two refusal arms.
 *
 * `cause` is present on exactly one of them — the arm for a call that rejected — and it
 * is where the daemon's envelope lands. Read through `in` rather than off the member,
 * because the settlement seam's own refusal shape declares none at all: it normalizes a
 * rejection into the console's one refusal directly, so its `code` IS the daemon's word
 * already and there is nothing nested to prefer.
 */
function refusalReading(refusal: GrowthUnavailable | SettledReadRefusal): {
  readonly code: string;
  readonly detail: string;
} {
  const cause = "cause" in refusal ? refusal.cause : undefined;
  return cause === undefined
    ? { code: refusal.code, detail: refusal.detail }
    : { code: cause.code, detail: cause.detail };
}
