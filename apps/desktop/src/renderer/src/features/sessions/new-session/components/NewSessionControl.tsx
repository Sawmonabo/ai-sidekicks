// "+ New": the one control that constructs a `NewSessionDraft`, mounted with the props
// `new-session-control-contract.ts` declares.
//
// It offers the first message only. The draft cannot compose `run.queueCreate` without the
// turn's body, and a session opened with nothing said waits on a person who thinks they sent
// something. Agents and repo mounts need reads this control would have to invent. No posture
// picker is drawn: neither strict request the send makes (`SessionCreateRequest`,
// `QueueItemCreateRequest`) has a member for one, so a picker would report success for a
// choice nothing acted on. The lead comes from the props.
//
// A partial send names what landed as well as what did not, so a person deciding whether to
// press again sees the session that exists. Send is disabled while a send runs as the
// affordance; the draft coalescing repeated sends is the structural guard.
//
// Discard and "+ New" stay reachable during a send, so a send can settle over a composition
// it was not sent for. The result, the announcement and the sending flag are therefore held
// per draft (`hooks/subject-scoped/useSubjectScopedState.ts`), and a publisher captured at
// Send installs nothing once another composition is on screen. The draft is held on the bridge
// it sends through (`hooks/subject-scoped/useSubjectScopedResource.ts`), so a bridge
// replacement discards it and "+ New" is offered again on the live one, instead of a Send
// that lands nowhere the console reads.
//
// Only a completed send hands the session out, through `onSessionCreated`. A partial send
// keeps the draft, so its refusal stays on screen and a second press resumes at the failed
// leg. A completed send closes only the composition it carried: the draft stays editable while
// the create runs, so the send names the draft revision it read and the settlement closes the
// draft only when that revision is still current. The field is `readOnly` while a send runs
// (not disabled, so focus and a screen reader's position survive); that narrows the window to
// the frame between click and render, which is why the revision is the guard.

import "./NewSessionControl.css";

import { InlineRefusal } from "@renderer/components/Refusal/InlineRefusal.js";
import type { NewSessionControlProps } from "../new-session-control-contract.js";
import { useNewSessionComposition } from "../hooks/useNewSessionComposition.js";

/**
 * Why the first message cannot be edited right now. The field is read-only rather than
 * disabled, because a disabled control leaves the tab order and takes focus with it.
 */
const SENDING_FIRST_TURN_REASON =
  "This draft is being sent, so its first message cannot be edited until the send settles.";

/** The new-session draft and the send that starts a session from it. */
export function NewSessionControl(props: NewSessionControlProps): React.JSX.Element {
  const composition = useNewSessionComposition(props);

  if (composition.draftState === undefined) {
    return (
      <button type="button" className="meridian-new-session__open" onClick={composition.open}>
        + New
      </button>
    );
  }

  const completedCalls = composition.sendResult?.completedCalls ?? [];

  return (
    <section className="meridian-new-session" aria-label="New session draft">
      <label className="meridian-new-session__first-turn">
        Its first message
        <textarea
          className="meridian-new-session__first-turn-input"
          value={composition.draftState.firstTurn}
          rows={3}
          readOnly={composition.isSending}
          title={composition.isSending ? SENDING_FIRST_TURN_REASON : undefined}
          onChange={(event) => {
            composition.setFirstTurn(event.target.value);
          }}
        />
      </label>
      {composition.sendResult?.refusal === undefined ? null : (
        <InlineRefusal
          code={composition.sendResult.refusal.code}
          detail={composition.sendResult.refusal.detail}
        />
      )}
      {composition.unsentEditsSentence === undefined ? null : (
        // A plain paragraph, unlike the completed-calls line below: the composition announces
        // this sentence when the settlement lands, so a status region would say it twice.
        <p className="meridian-new-session__unsent">{composition.unsentEditsSentence}</p>
      )}
      {completedCalls.length === 0 ? null : (
        // A status region: what already exists is the half of a partial send a person acts
        // on, and it arrives after the press.
        <p className="meridian-new-session__completed" role="status">
          {`Already sent: ${completedCalls.join(", ")}`}
        </p>
      )}
      <div className="meridian-new-session__actions">
        <button type="button" className="meridian-new-session__discard" onClick={composition.close}>
          Discard
        </button>
        {/* Replaces Send once the create's reply could not be read: the directory read names
            a session that was made, and a second send would make another. */}
        {composition.isAmbiguousCreate ? (
          <button
            type="button"
            className="meridian-new-session__recheck"
            onClick={composition.recheckDirectory}
          >
            Check the sessions list
          </button>
        ) : null}
        <button
          type="button"
          className="meridian-new-session__send"
          disabled={
            composition.draftState.isEmpty ||
            composition.isSending ||
            composition.isAmbiguousCreate ||
            composition.unsentEditsSentence !== undefined
          }
          title={composition.unsentEditsSentence}
          onClick={composition.send}
        >
          Send
        </button>
      </div>
    </section>
  );
}
