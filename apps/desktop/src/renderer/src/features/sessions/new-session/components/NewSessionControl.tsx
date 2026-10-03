// "+ New": the one control that constructs a `NewSessionDraft`. It offers the first message
// only, since the draft cannot compose `run.queueCreate` without the turn's body; the lead
// comes from the props. Discard and "+ New" stay reachable during a send, so the result and the
// sending flag are held per draft and a settlement closes the draft only while the revision it
// sent is still current. The field is `readOnly`, not disabled, while a send runs, so focus and
// a screen reader's position survive.

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
