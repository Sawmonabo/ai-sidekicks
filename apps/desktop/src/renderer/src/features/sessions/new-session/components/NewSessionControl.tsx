// "+ New": the control that makes a new-session draft reachable.
//
// This is the one control that constructs a `NewSessionDraft`, so the draft's
// selection, discard and first-send behavior reach a person. It is mounted with the
// props `new-session-control-contract.ts` declares, by whichever composition supplies
// the first-message call.
//
// WHAT IT OFFERS, AND WHY THAT AND NOT MORE. The first message, and nothing else: the
// draft cannot compose `run.queueCreate` without the turn's own body, and a session
// opened with nothing said is a session waiting on a person who thinks they already
// sent something. Agents and repo mounts are not offered because both need reads this
// control would have to invent, and an unasked question belongs in the _not checked_
// absence rather than in a picker with nothing behind it.
//
// AND THE POSTURE PICKER IS GONE FOR THE SHARPER VERSION OF THAT RULE: a control whose
// choice cannot be honored is worse than an absent one, because it reports success for
// a decision nothing acted on. The two calls the send makes carry nowhere to put it:
// `SessionCreateRequest` carries where the session works and who leads it, and
// `QueueItemCreateRequest` the message, its files and where it goes, both `.strict()`.
// The lead is the mounting composition's, through the props, because a model and an
// effort are choices this control does not offer.
//
// AND A PARTIAL SEND NAMES WHAT LANDED, not only what did not. Both of the
// draft's calls are reachable, so a send that stops part way leaves a real session
// with some of what was asked for on it — and the person deciding whether to press
// again is reading for exactly that. The refusal says what could not be done; the
// line beneath it says what exists.
//
// SEND IS DISABLED WHILE A SEND IS RUNNING, AND THAT IS THE SECOND GUARD. The draft
// coalesces repeated sends itself, so pressing twice cannot mint two sessions
// whatever this control does; disabling the button is what stops a person pressing
// into a control that looks like it did nothing. Structural guard first, affordance
// second — never the affordance alone, which is a guard that a keyboard path or a
// later caller does not get.
//
// AND A SETTLEMENT BELONGS TO THE DRAFT THAT ASKED FOR IT. Discard is reachable
// while a send is in flight, and "+ New" is reachable the moment it is — so a send
// can settle over a composition that is not the one it was sent for. The result, the
// announcement and the sending flag are therefore held per DRAFT, through
// `hooks/subject-scoped/useSubjectScopedState.ts`: a publisher captured when Send was pressed names
// the draft that pressed it, and installs nothing once the composition on screen is
// another one. Two sends in flight is the case that has to be per-draft: one boolean
// over two drafts re-enables Send under a composition that is still waiting.
//
// AND THE DRAFT ITSELF BELONGS TO THE BRIDGE IT WOULD SEND THROUGH. A draft holds
// the bridge it was composed against and sends `session.create` through that one, so
// a bridge REPLACEMENT — a reconnect, a second window's own instance, the fixture's
// scenario switch — leaves a draft addressed to a transport that is gone. The draft
// is held through `hooks/subject-scoped/useSubjectScopedResource.ts` on the bridge, so a replacement
// discards it and the control offers "+ New" again on the live one. That loses a
// composition, and it is the honest half of the trade: the alternative is a Send that
// looks ordinary and either never lands or lands somewhere the console will not read
// again, and a `sessionId` reported back for a session nobody can open.
//
// AND A COMPLETED SEND HANDS THE SESSION OUT. A continuation that published its report
// and stopped would leave a form on screen with Send still enabled and a real daemon
// session the console could not name — absent from the all-sessions list until some
// later directory read happened to notice it, and carrying none of the origin markers
// only this window can report. The control names the session through
// `onSessionCreated`, and the destination that mounts it settles the start on its own
// terms.
//
// AND IT IS THE COMPLETED ARM ALONE. A partial send made a session too, and the draft
// stays for it on purpose: its refusal says which leg could not be made and a second
// press resumes at exactly that one. Navigating away would take that sentence with it,
// and would stamp a start the person has not finished making.
//
// AND A COMPLETED SEND CLOSES THE COMPOSITION IT CARRIED, NOT WHATEVER IS ON SCREEN.
// The send captures the first message when it reads the draft, and the draft is
// editable for as long as the create is in flight — so a settlement that published
// `undefined` over the field discarded words that were never sent and left no copy of
// them anywhere. Two guards, and the order is the usual one. The STRUCTURAL half is a
// revision the draft advances on every edit: the send names the one it carried, and the
// settlement closes the draft only where the two agree, saying so through the same
// settlement line where they do not. The AFFORDANCE half is this field, which is
// `readOnly` while a send runs — read-only rather than disabled, so focus and a screen
// reader's position survive the press — and it narrows the window to the frame between
// the click and the render, which is why the revision is the guard and not the field.

import "./NewSessionControl.css";

import { InlineRefusal } from "@renderer/components/Refusal/InlineRefusal.js";
import type { NewSessionControlProps } from "../new-session-control-contract.js";
import { useNewSessionComposition } from "../hooks/useNewSessionComposition.js";

/**
 * Why the first message cannot be edited right now.
 *
 * READ-ONLY AND NOT DISABLED, which is the whole of the choice. A disabled control
 * leaves the tab order and takes focus with it, so a person typing when the press
 * landed would find their place gone and a screen reader would lose the field it was
 * on. Read-only keeps both and refuses the edit.
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
        // A PLAIN paragraph, unlike the completed-calls line below it, and the
        // difference is which of them is already spoken. The composition announces this
        // exact sentence when the settlement lands, so a status region here would say it
        // twice to the one person who cannot see it — the same reason `InlineRefusal`
        // above carries no live region for a refusal the announcer has already read.
        <p className="meridian-new-session__unsent">{composition.unsentEditsSentence}</p>
      )}
      {completedCalls.length === 0 ? null : (
        // A status region rather than a paragraph: what already exists is the half of
        // a partial send a person acts on, and it arrives after the press rather than
        // with the rest of the form.
        <p className="meridian-new-session__completed" role="status">
          {`Already sent: ${completedCalls.join(", ")}`}
        </p>
      )}
      <div className="meridian-new-session__actions">
        <button type="button" className="meridian-new-session__discard" onClick={composition.close}>
          Discard
        </button>
        {/* The act that replaces Send once the create's reply could not be read. It is
            offered INSTEAD OF a retry and never beside one: the directory read is
            what would name a session that was made, and a second send would make
            another. So the control is disabled with its sentence beside it, and the
            act that IS available is drawn rather than left to be guessed at. */}
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
