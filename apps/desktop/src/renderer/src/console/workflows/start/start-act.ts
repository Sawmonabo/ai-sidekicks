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

import { useCallback } from "react";

import {
  settleGrowthRead,
  type GrowthPort,
  type GrowthUnavailable,
  type SettledReadRefusal,
} from "../../bridge/index.js";
import { useSubjectScopedState } from "../../store/index.js";
import type { WorkflowDefinitionRow } from "../definitions/definition-rows.js";

/** What the picker knows about the start it last asked for. */
export type WorkflowStartAct =
  | { readonly status: "idle" }
  | { readonly status: "starting"; readonly definitionId: string }
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
      publish({ status: "starting", definitionId: definition.id });
      void settleGrowthRead(
        growth.workflowRunStart({
          workflowVersionId: definition.latestWorkflowVersionId,
          sessionId,
          ...(channelId === undefined ? {} : { channelId }),
        }),
      ).then((outcome) => {
        // Published through the holder's own handle, which carries the addressing it was
        // captured under: an answer arriving after the composer moved to another session
        // writes nowhere rather than reporting one session's run under another's menu.
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
    },
    [growth, sessionId, channelId, publish],
  );

  return { act, start };
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
