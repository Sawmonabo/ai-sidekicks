// "+ New": the control that makes a new-session draft reachable.
//
// `NewSessionDraft` shipped with a co-located test and no consumer — no control
// anywhere constructed one, so none of the draft selection, discard, or first-send
// behaviour it holds could be reached by a person. This is that consumer, on the
// sessions destination, which is where the corpus puts starting a session.
//
// WHY IT IS A SECOND CONTROL BESIDE "START A SESSION" AND NOT A REPLACEMENT. They
// are two acts. "Start a session" mounts the shipped Tier-1 probe, which creates one
// immediately with nothing chosen. A DRAFT is a session a person composes before it
// exists — no daemon row until the first send, and closing it empty leaves nothing
// behind. Replacing the probe would delete a path that works today; hiding the draft
// behind it would leave the composed path unreachable, which is the defect.
//
// WHAT IT OFFERS, AND WHY THAT AND NOT MORE. The first message, and nothing else: the
// draft cannot compose `run.queueCreate` without the turn's own body, and a session
// opened with nothing said is a session waiting on a person who thinks they already
// sent something. Agents and repo mounts are not offered because both need reads this
// surface would have to invent, and `Spec-023 §Console Design (Meridian)` rule 8 puts
// an unasked question in the _not checked_ absence rather than in a picker with
// nothing behind it.
//
// AND THE POSTURE PICKER IS GONE FOR THE SHARPER VERSION OF THAT RULE: a control whose
// choice cannot be honoured is worse than an absent one, because it reports success for
// a decision nothing acted on. The posture travelled only inside `sendNewSessionDraft`'s
// `agentAttach` loop, which iterates `request.agents` — empty on every send this build
// can make, since no surface calls `NewSessionDraft.selectAgent`. And the two calls that
// ARE made carry nowhere to put it: the registered `SessionCreateRequest` is
// `{ config?, metadata? }` and `QueueItemCreateRequest` is
// `{ sessionId, channelId?, workspaceId?, priority?, payload }`, both `.strict()`, and
// the only request member in the corpus that carries an execution posture is
// `AgentResolvedConfiguration.executionPostureMode` on the growth-slate `agent.attach`.
// So the axis comes back with the agent picker that makes the attach leg reachable —
// `NewSessionDraft` keeps `setPosture` beside `selectAgent` for exactly that lane, and
// the send already honours it on the leg that can carry it.
//
// AND A PARTIAL SEND NAMES WHAT LANDED, not only what did not. All three of the
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
// AND SEND IS CLOSED WHILE THE DESTINATION IS NOT PUTTING ACTS AT ALL. The three
// controls beside this one — start, join, import — have carried that cause since they
// were drawn, and this one did not: it took the bridge and nothing else, and stayed
// live through a stopped supervisor while the sentence above it said mutations could
// not be put. The cause arrives through `seats/new-session-seat.ts` rather than being
// derived here, because a control that recomputed its own eligibility would be a
// second source of truth for a fact the stores own — and it arrives as a reading
// answering at two moments, because the guard behind the affordance has to ask again
// when the press lands. The sentence itself is NOT re-rendered here: the section
// already draws it once, and a control repeating it would put one fact on screen
// twice.
//
// THE BLOCK CLOSES SEND AND NOT "+ New". Opening a draft mints no daemon row and puts
// nothing on any wire, so refusing to let somebody compose one while the runtime is
// away would take the offline half of this control away for nothing.
//
// AND A SETTLEMENT BELONGS TO THE DRAFT THAT ASKED FOR IT. Discard is reachable
// while a send is in flight, and "+ New" is reachable the moment it is — so a send
// can settle over a composition that is not the one it was sent for. The result, the
// announcement and the sending flag are therefore held per DRAFT, through
// `store/subject-scoped-state.ts`: a publisher captured when Send was pressed names
// the draft that pressed it, and installs nothing once the composition on screen is
// another one. Two sends in flight is the case that has to be per-draft: one boolean
// over two drafts re-enables Send under a composition that is still waiting.
//
// AND THE DRAFT ITSELF BELONGS TO THE BRIDGE IT WOULD SEND THROUGH. A draft holds
// the bridge it was composed against and sends `session.create` through that one, so
// a bridge REPLACEMENT — a reconnect, a second window's own instance, the fixture's
// scenario switch — leaves a draft addressed to a transport that is gone. The draft
// is held through `store/subject-scoped-resource.ts` on the bridge, so a replacement
// discards it and the control offers "+ New" again on the live one. That loses a
// composition, and it is the honest half of the trade: the alternative is a Send that
// looks ordinary and either never lands or lands somewhere the console will not read
// again, and a `sessionId` reported back for a session nobody can open.
//
// AND A COMPLETED SEND HANDS THE SESSION OUT, WHICH IS THE HALF THAT WAS MISSING. The
// continuation used to publish its report and stop, so a send that fully succeeded
// left a form on screen with Send still enabled and a real daemon session the console
// could not name — absent from the all-sessions list until some later directory read
// happened to notice it, and carrying none of the origin markers only this window can
// report. The control now names the session through `seats/new-session-seat.ts`, and
// the destination that mounts it settles the start on its own terms.
//
// AND IT IS THE COMPLETED ARM ALONE. A partial send made a session too, and the draft
// stays for it on purpose: its refusal says which leg could not be made and a second
// press resumes at exactly that one. Navigating away would take that sentence with it,
// and would stamp a start the person has not finished making.

import { InlineRefusal } from "../../primitives/index.js";
import type { NewSessionControlProps } from "../../seats/index.js";
import { useNewSessionComposition } from "./new-session-composition.js";

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
            another. `Spec-023 §Console Design (Meridian)` rule 9 — the control is
            disabled with its sentence beside it, and the act that IS available is
            drawn rather than left to be guessed at. */}
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
            props.blockedAct.sentence !== undefined
          }
          title={props.blockedAct.sentence}
          onClick={composition.send}
        >
          Send
        </button>
      </div>
    </section>
  );
}
