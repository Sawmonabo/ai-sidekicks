// "+ New": the one control that constructs a `NewSessionDraft`. It offers the first message
// only, since the draft cannot compose `run.queueCreate` without the turn's body; the lead
// comes from the props. Discard and "+ New" stay reachable during a send, so the result and the
// sending flag are held per draft and a settlement closes the draft only while the revision it
// sent is still current. The field is `readOnly`, not disabled, while a send runs, so focus and
// a screen reader's position survive.

import "./NewSessionControl.css";

import { Button } from "@base-ui/react/button";

import { HoverLabel } from "#renderer/components/HoverLabel/HoverLabel.js";
import { InlineRefusal } from "#renderer/components/Refusal/InlineRefusal.js";
import { TextBox } from "#renderer/components/TextBox/TextBox.js";
import type { NewSessionControlProps } from "../control-contract.js";
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
      <label className="meridian-form__field">
        <span className="meridian-form__label">Its first message</span>
        <HoverLabel
          text={composition.isSending ? SENDING_FIRST_TURN_REASON : undefined}
          textRole="description"
        >
          <TextBox
            className="meridian-new-session__first-turn-input meridian-form__input"
            fieldClassName="meridian-form__text-area"
            value={composition.draftState.firstTurn}
            rows={3}
            readOnly={composition.isSending}
            onChange={(event) => {
              composition.setFirstTurn(event.target.value);
            }}
          />
        </HoverLabel>
      </label>
      {composition.sendResult?.refusal === undefined ? null : (
        <InlineRefusal
          code={composition.sendResult.refusal.code}
          detail={composition.sendResult.refusal.detail}
        />
      )}
      {/* A plain paragraph: the composition says the unsent-edits sentence as the create lands, so
          saying it here would say it twice. */}
      {composition.unsentEditsSentence === undefined ? null : (
        <p className="meridian-new-session__unsent">{composition.unsentEditsSentence}</p>
      )}
      {completedCalls.length === 0 ? null : (
        <p className="meridian-new-session__completed">
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
        {/* Disabled yet focusable, so the keyboard reaches its hover label where it has one. */}
        <HoverLabel text={composition.unsentEditsSentence} textRole="description">
          <Button
            className="meridian-new-session__send"
            disabled={
              composition.draftState.isEmpty ||
              composition.isSending ||
              composition.isAmbiguousCreate ||
              composition.unsentEditsSentence !== undefined
            }
            focusableWhenDisabled
            onClick={composition.send}
          >
            Send
          </Button>
        </HoverLabel>
      </div>
    </section>
  );
}
