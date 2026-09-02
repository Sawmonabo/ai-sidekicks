// The one structured goal a session may hold, with setting and clearing as two
// different acts.
//
// Five rules, each visible in the code. The first and the fourth are the corpus's —
// `api-payload-contracts.md §Plan-016 — Multi-Agent Channels And Orchestration`
// registers the two operations and the field's bounds — and the other three are
// this card's own, because no committed document states them:
//
//   • **Set and clear are two controls.** There is no single control with an empty
//     value, because an update without a goal is malformed rather than a clear, and
//     the clear action sits INSIDE the editor rather than beside the read-only line.
//   • **Nothing is optimistic.** The card renders `foldSessionGoal` over the store's
//     timeline and never its own last-known text, so the goal shown is one the log
//     actually carries. The editor closes when the fold moves, not when a reply
//     lands — a reply confirms the request, and the event is what commits it.
//   • **One mutation in flight per session.** A second submit while one is settling
//     is not queued; the daemon's own `session.goal_mutation_in_flight` is rendered
//     as a conflict with a retry, and the control refuses locally in the same shape
//     rather than stacking a second call behind the first.
//   • **The field refuses on the daemon's rule.** One to 4096 characters, non-blank,
//     NUL-rejected, checked before the call rather than truncated to fit.
//   • **A read-only role has no control at all.** Eligibility is never derived here:
//     the caller supplies it, and an unknown role is treated as read-only, which is
//     the fail-closed arm.
//
// Turn-boundary effectiveness and cross-node honesty are stated in the copy rather
// than implied by an animation: a goal change governs the NEXT turn, an in-flight
// turn completes under the prior prompt, and a leg on a remote node may run a turn
// under the prior goal while the relayed event is still travelling.

import { useCallback, useEffect, useId, useState } from "react";

import { DerivedFigure, InlineRefusal, Nothing } from "../../primitives/index.js";
import { type ConsoleRefusal } from "../../core/index.js";
import { SESSION_GOAL_MAX_LENGTH } from "./approvals-bounds.js";
import { sessionGoalTextSchema, type SessionGoalProjection } from "./session-goal.js";

export interface SessionGoalCardProps {
  readonly goal: SessionGoalProjection;
  /**
   * Whether this participant's role may mutate the goal.
   *
   * `undefined` means the role has not been read. Treated exactly as read-only: the
   * console never derives an eligibility, and offering a control on an unknown role
   * would be deriving one.
   */
  readonly canMutate: boolean | undefined;
  readonly isMutating: boolean;
  readonly refusal: ConsoleRefusal | undefined;
  readonly onUpdate: (text: string) => void;
  readonly onClear: () => void;
}

export function SessionGoalCard(props: SessionGoalCardProps): React.JSX.Element {
  const { goal } = props;
  const fieldId = useId();
  const [isEditing, setIsEditing] = useState(false);
  const [draftText, setDraftText] = useState("");

  // The editor closes when the LOG moves, which is the only thing that commits a
  // goal. Closing on the reply instead would leave the card showing the new text
  // while the event was still being acknowledged across the session's bindings.
  useEffect(() => {
    setIsEditing(false);
  }, [goal]);

  const submit = useCallback(() => {
    const parsed = sessionGoalTextSchema.safeParse(draftText);
    if (!parsed.success) {
      return;
    }
    props.onUpdate(parsed.data);
  }, [draftText, props]);

  const validation = sessionGoalTextSchema.safeParse(draftText);
  const canSubmit = validation.success && !props.isMutating;

  return (
    <section className="meridian-goal" aria-label="Session goal">
      <div className="meridian-goal__line">
        <GoalReading goal={goal} />
        {props.canMutate === true && !isEditing ? (
          <button
            className="meridian-goal__open"
            type="button"
            onClick={() => {
              setDraftText(goal.status === "set" ? goal.text : "");
              setIsEditing(true);
            }}
          >
            {goal.status === "set" ? "Change goal" : "Set a goal"}
          </button>
        ) : null}
      </div>

      {props.canMutate === true && isEditing ? (
        <div className="meridian-goal__editor">
          <label className="meridian-goal__label" htmlFor={fieldId}>
            The goal this session is working towards
          </label>
          <textarea
            className="meridian-goal__field"
            id={fieldId}
            maxLength={SESSION_GOAL_MAX_LENGTH}
            value={draftText}
            onChange={(event) => {
              setDraftText(event.target.value);
            }}
          />
          <p className="meridian-goal__effectiveness">
            A goal change takes effect at the next turn boundary. A turn already in flight finishes
            under the previous prompt, and where this session spans nodes a remote leg may run a
            turn under the previous goal until the change reaches it.
          </p>
          {validation.success || draftText === "" ? null : (
            <p className="meridian-goal__invalid" role="status">
              {validation.error.issues[0]?.message ?? "This goal cannot be sent as written."}
            </p>
          )}
          <div className="meridian-goal__actions">
            <button
              className="meridian-goal__save"
              type="button"
              disabled={!canSubmit}
              onClick={submit}
            >
              Save goal
            </button>
            {/* Clearing lives inside the editor, never beside the read-only line. */}
            <button
              className="meridian-goal__clear"
              type="button"
              disabled={props.isMutating || goal.status !== "set"}
              onClick={props.onClear}
            >
              Clear the goal
            </button>
            <button
              className="meridian-goal__cancel"
              type="button"
              onClick={() => {
                setIsEditing(false);
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {props.isMutating ? (
        <Nothing kind="computing" placement="inline" title="The goal change is settling." />
      ) : null}
      {props.refusal === undefined ? null : <InlineRefusal {...props.refusal} />}
    </section>
  );
}

/** The read-only line: one goal, clamped to one measure, or an explicit absence. */
function GoalReading(props: { readonly goal: SessionGoalProjection }): React.JSX.Element {
  if (props.goal.status === "set") {
    return <p className="meridian-goal__text">{props.goal.text}</p>;
  }
  if (props.goal.status === "unreadable") {
    return (
      <Nothing
        kind="error"
        placement="inline"
        title="The latest goal event could not be read."
        detail="A goal event landed carrying a shape this build does not recognise, so the goal shown would be a guess."
      />
    );
  }
  return <DerivedFigure text="No goal set" />;
}
