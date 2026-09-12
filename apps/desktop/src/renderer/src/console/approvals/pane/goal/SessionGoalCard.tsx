// The one structured goal a session may hold, with setting and clearing as two
// different acts.
//
// Five rules, each visible in the code. The first and the fourth are the wire's — it
// registers the two operations and the field's bounds — and the other three are this
// card's own:
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
//   • **The editor belongs to the session it was opened for.** The pane is rebound
//     from one session to another by a prop change, and a card that closed only on
//     a goal revision kept the open editor and the half-typed text across that move
//     — every session with no goal reads the same `"unset"` revision, and an
//     origin-keyed one names the appending daemon rather than the session, so two
//     sessions routinely present the same revision and the effect never fired. Save
//     then dispatched text authored for one session through the other's `onUpdate`.
//     So the editor rides `useSessionScopedState`, which resets it during the render
//     that first sees a new `(bridge, sessionId)`: the first frame under the new
//     session is the closed editor, and the draft is gone rather than re-addressed.
//     The revision rule stands beside it, closing the editor when the LOG moves.
//
// Turn-boundary effectiveness and cross-node honesty are stated in the copy rather
// than implied by an animation: a goal change governs the NEXT turn, an in-flight
// turn completes under the prior prompt, and a leg on a remote node may run a turn
// under the prior goal while the relayed event is still travelling.

import { useCallback, useEffect, useId } from "react";
import {
  ACCENT_FILL_CLASS,
  Nothing,
  RemediedRefusal,
  WireFigure,
} from "../../../primitives/index.js";
import { readRefusalExtensions, type ConsoleRefusal } from "../../../core/index.js";
import type { ConsoleBridge } from "../../../bridge/index.js";
import { useSessionScopedState } from "../../../seats/index.js";
import { isSendableGoalText } from "../../../bridge/index.js";
import { SESSION_GOAL_MAX_LENGTH } from "../../../core/index.js";
import { type SessionGoalProjection } from "../../../bridge/index.js";
import { canClearSessionGoal } from "./goal-clear-eligibility.js";
import { GoalReading } from "./GoalReading.js";

/**
 * The editor, which is either closed or open over one draft.
 *
 * One value rather than a flag beside a string, so "closed" cannot carry a draft:
 * the state a rebind resets is the whole editor, and there is no second field left
 * holding text authored for the session the card has moved off.
 */
type GoalEditorState =
  | { readonly isOpen: false }
  | { readonly isOpen: true; readonly draftText: string };

const CLOSED_GOAL_EDITOR: GoalEditorState = { isOpen: false };

export interface SessionGoalCardProps {
  /**
   * The transport the goal belongs to, and the session it belongs to.
   *
   * Both, because both can change under a mounted card — the pane is rebound to
   * another session by a prop change and the window's bridge is replaced by the
   * fixture picker — and the editor belongs to the pair rather than to the mount.
   */
  readonly bridge: ConsoleBridge;
  readonly sessionId: string;
  readonly goal: SessionGoalProjection;
  readonly isMutating: boolean;
  readonly refusal: ConsoleRefusal | undefined;
  readonly onUpdate: (text: string) => void;
  readonly onClear: () => void;
}

export function SessionGoalCard(props: SessionGoalCardProps): React.JSX.Element {
  const { goal } = props;
  const fieldId = useId();
  // Held under the session it was opened for. The reset runs during the render that
  // first sees a new subject, so no frame commits one session's draft under another
  // — an effect would clear it one frame late, with Save reachable in between.
  const { value: editor, publish: publishEditor } = useSessionScopedState<GoalEditorState>(
    props.bridge,
    props.sessionId,
    () => CLOSED_GOAL_EDITOR,
  );
  const draftText = editor.isOpen ? editor.draftText : "";

  // The editor closes when the LOG moves, which is the only thing that commits a
  // goal. Closing on the reply instead would leave the card showing the new text
  // while the event was still being acknowledged across the session's bindings.
  //
  // KEYED ON THE PROJECTION'S REVISION AND NOT ON THE PROJECTION. The fold runs over
  // the whole timeline and answers with a fresh object every time the timeline
  // grows, so keying on the object closed this editor — discarding a half-typed goal
  // — on any `usage.*` beat or run transition that happened to land while somebody
  // was typing. The revision moves when a different goal event wins the fold and at
  // no other time, which is exactly the condition this effect is about.
  //
  // It answers the LOG's movement and nothing else. A rebind to another session is a
  // different question — the revisions of two sessions are not comparable, and two
  // goal-less ones are equal — and it is answered above, by the subject the editor
  // is held under, rather than by widening this effect's key.
  const goalRevision = goal.revision;
  useEffect(() => {
    publishEditor(CLOSED_GOAL_EDITOR);
  }, [goalRevision, publishEditor]);

  const submit = useCallback(() => {
    if (!isSendableGoalText(draftText)) {
      return;
    }
    props.onUpdate(draftText);
  }, [draftText, props]);

  const isSendable = isSendableGoalText(draftText);
  const canSubmit = isSendable && !props.isMutating;

  return (
    <section className="meridian-goal" aria-label="Session goal">
      <div className="meridian-goal__line">
        <GoalReading goal={goal} />
        {!editor.isOpen ? (
          <button
            className="meridian-goal__open"
            type="button"
            onClick={() => {
              publishEditor({
                isOpen: true,
                draftText: goal.status === "set" ? goal.text : "",
              });
            }}
          >
            {goal.status === "set" ? "Change goal" : "Set a goal"}
          </button>
        ) : null}
      </div>

      {editor.isOpen ? (
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
              publishEditor({ isOpen: true, draftText: event.target.value });
            }}
          />
          <p className="meridian-goal__effectiveness">
            A goal change takes effect at the next turn boundary. A turn already in flight finishes
            under the previous prompt, and where this session spans nodes a remote leg may run a
            turn under the previous goal until the change reaches it.
          </p>
          {isSendable || draftText === "" ? null : (
            // The console's own sentence and never the validator's, which quotes the
            // value it rejected — and the value here is what a user typed.
            <p className="meridian-goal__invalid" role="status">
              This goal cannot be sent as written.
            </p>
          )}
          <div className="meridian-goal__actions">
            {/* The editor's one primary action, and the only control here that takes
                the accent as its face (rule 1). */}
            <button
              className={`meridian-goal__save ${ACCENT_FILL_CLASS}`}
              type="button"
              disabled={!canSubmit}
              onClick={submit}
            >
              Save goal
            </button>
            {/* Clearing lives inside the editor, never beside the read-only line.
                The enabling rule is `canClearSessionGoal`, the same predicate the
                palette's clear row is offered on — one expression, two surfaces. */}
            <button
              className="meridian-goal__clear"
              type="button"
              disabled={!canClearSessionGoal(goal, props.isMutating)}
              onClick={props.onClear}
            >
              Clear the goal
            </button>
            <button
              className="meridian-goal__cancel"
              type="button"
              onClick={() => {
                publishEditor(CLOSED_GOAL_EDITOR);
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
      {props.refusal === undefined ? null : (
        // The mutation's own refusal, with the console's next move beside it and —
        // where `session.goal_delivery_failed` named them — the bindings the daemon
        // reported failing. Those ride `data.fields.failedBindingIds` as registered
        // identifiers, so they render as wire figures rather than folded into a
        // sentence: "no goal change" without naming which legs refused leaves a
        // person with nothing to check.
        <RemediedRefusal refusal={props.refusal} detailAction={failedBindings(props.refusal)} />
      )}
    </section>
  );
}

/**
 * The bindings a delivery failure named, or nothing.
 *
 * Read through the registered extension reader rather than off the refusal by hand:
 * the reader is total over an unvalidated value and drops an element that is not an
 * identifier, so a malformed envelope contributes no row instead of one naming
 * nobody. A refusal that named none renders no list at all — an empty one would say
 * the daemon reported no failing binding, which is a different fact.
 */
function failedBindings(refusal: ConsoleRefusal): React.ReactNode {
  const { failedBindingIds } = readRefusalExtensions(refusal);
  if (failedBindingIds === undefined) {
    return undefined;
  }
  return (
    <span className="meridian-goal__failed-bindings">
      {failedBindingIds.map((bindingId) => (
        <WireFigure key={bindingId} value={bindingId} />
      ))}
    </span>
  );
}
