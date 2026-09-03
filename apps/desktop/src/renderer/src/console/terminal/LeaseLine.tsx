// The lease line: who holds the session's one shared shell, and the single control
// that changes that.
//
// `Spec-023 §Console Design (Meridian)` 8.8 fixes this surface's density — "the
// pane shows output and the holder line only; the transition history is one click
// away, and the claim control is the single affordance in the header" — and its
// three prohibitions, each of which is a line of code here rather than a note:
//
//   • **Never derives the holder from the last observed claim.** Pressing the
//     control calls the wire and then does nothing to the holder. The line moves
//     when a `pty.control_changed` transition reaches the fold, and not before.
//   • **Never animates a claim by the current holder.** A holder sees Release, so
//     the idempotent self-claim — which succeeds and broadcasts nothing — is not
//     reachable from this surface at all. There is no transition to animate
//     because there is no transition.
//   • **Never queues a claim.** A refusal renders beside the control and stays
//     there until the person acts. No retry, no timer, no wait list — 8.8 makes a
//     refused claim something a person retries by hand or not at all.
//   • **Never offers a claim it cannot attribute.** The control acts on the caller's
//     behalf and the fold names the holder by participant id, so until the viewer's
//     identity has been READ there is no control here at all — a designed absence
//     while the read is in flight, the wire's own refusal when it was refused. With
//     a placeholder viewer the daemon would grant the lease and this surface would
//     read the grant back as somebody else's hold: still Claim, no way to release,
//     and the emulator read-only over a shell the person owns.
//
// EVERY TRANSITION NAMES ITS REASON. The disclosure renders one ledger line per
// transition through the console's own row primitive, attributed in the actor's
// hue, and the sentence comes from `lease-model.ts`'s table — which is total over
// the closed reason set, so the three automatic reasons cannot collapse into one.
//
// STEPPING IN IS NOT THIS CONTROL (8.9). The composer's Step in pauses a run and
// hands over the conversation; it never moves the keyboard. One line says so where
// a person might otherwise reach for the wrong thing, and it is copy rather than a
// second affordance for exactly that reason.

import { useCallback, useState } from "react";

import type { ConsoleBridge } from "../bridge/index.js";
import {
  Chip,
  DerivedFigure,
  InlineRefusal,
  LedgerRow,
  Nothing,
  WireFigure,
  formatCount,
  type ChipTone,
} from "../primitives/index.js";
import {
  participantHueTokenName,
  tokenReference,
  type ParticipantRingTreatment,
} from "../tokens/index.js";
import { useTerminalLeaseClaim } from "./lease-claim.js";
import {
  terminalLeaseTransitionSentence,
  type TerminalLeaseHolding,
  type TerminalLeaseState,
} from "./lease-model.js";
import type { TerminalViewerIdentity } from "./viewer-identity.js";

/** How a participant is drawn: the wheel step and the treatment that disambiguates it. */
export interface TerminalParticipantMark {
  readonly hueStep: number;
  readonly ringTreatment: ParticipantRingTreatment;
  /**
   * The name a person reads, when the roster has supplied one. Absent is the
   * ordinary state today — no projector claims `participant.joined` yet — and the
   * surface then renders the wire id in mono rather than inventing a name.
   */
  readonly displayName: string | undefined;
}

export interface LeaseLineProps {
  readonly bridge: ConsoleBridge;
  /**
   * The session whose one shared shell this lease governs.
   *
   * The session and not the pane, because that is what the registered pair carries:
   * `session.takeControl` and `session.releaseControl` both take `{ sessionId }`
   * (`api-payload-contracts.md §Session Terminal-Control Method Registry`), and V1
   * gives a session exactly one shared terminal, so the session id is the lease's
   * subject rather than a stand-in for one. The pane keeps its own local id for the
   * emulator it mounts; that id never reaches this wire.
   */
  readonly sessionId: string;
  readonly state: TerminalLeaseState;
  /**
   * How a participant is drawn, or `undefined` for one the wheel has never
   * admitted. Fail-closed by construction: an unknown participant takes the
   * neutral boundary and its wire id rather than somebody else's hue and name.
   */
  readonly markFor: (participantId: string) => TerminalParticipantMark | undefined;
  /**
   * Which participant this window is, which is what the claim control is gated on.
   *
   * The control acts on the caller's behalf and the fold names the holder by
   * participant id, so a surface that offered it without the identity would be
   * offering a control it cannot report the outcome of: a take would come back as
   * somebody else's hold, the button would still read Claim, and there would be no
   * way to release. `Spec-023 §Console Design (Meridian)` rule 9 offers controls and
   * renders refusals, and a control that cannot act is neither.
   */
  readonly viewerIdentity: TerminalViewerIdentity;
}

/**
 * What the chip says for each holding. Total over the closed set.
 *
 * `unrecognized-transition` is the one amber row, and rule 3's amber is spent on
 * exactly what it means: a person is needed. The daemon moved the shell under a
 * transition this build cannot read, so nobody can be told who holds it until
 * somebody updates this console or looks at the log — which is a different thing
 * from the neutral "not checked", where the console simply has not asked.
 */
const HOLDING_CHIPS: Readonly<Record<TerminalLeaseHolding, { label: string; tone: ChipTone }>> = {
  "not-checked": { label: "Not checked", tone: "neutral" },
  unheld: { label: "Free", tone: "neutral" },
  "held-by-you": { label: "You hold it", tone: "accent" },
  "held-by-another": { label: "Held", tone: "neutral" },
  "unrecognized-transition": { label: "Unread transition", tone: "attention" },
};

export function LeaseLine(props: LeaseLineProps): React.JSX.Element {
  const { bridge, sessionId, state, markFor, viewerIdentity } = props;
  const claim = useTerminalLeaseClaim(bridge, sessionId);
  const [isLedgerOpen, setIsLedgerOpen] = useState(false);

  const holderMark =
    state.holderParticipantId === null ? undefined : markFor(state.holderParticipantId);
  const chip = HOLDING_CHIPS[state.holding];
  const isHeldByViewer = state.holding === "held-by-you";

  // The health line is about the node a HOLDER sits on, so it is rendered only when
  // there is a holder. A `released` transition nulls the holder and the chip beside
  // it already reads Free, and "the console cannot say whether the holding node is
  // reachable" there discusses a machine the same line says nobody is using.
  //
  // The `unrecognized-transition` arm nulls the holder too, and this gate silences
  // the health line there as well — which reads correctly: what is unknown in that
  // state is the transition, and its own paragraph below says so, while a second
  // sentence about an unread roster would answer a question nobody asked.
  //
  // The gate is HERE and not in `readVouching`. `holderVouching` is a fact about
  // whether a roster read happened, and a fold that answered `vouched` because
  // nobody holds the lease would be reporting a read it never performed.
  const isHolderHealthUnread =
    state.holderParticipantId !== null && state.holderVouching === "not-checked";

  const onToggleLedger = useCallback(() => {
    setIsLedgerOpen((wasOpen) => !wasOpen);
  }, []);

  return (
    <div className="meridian-lease-line" role="group" aria-label="Terminal lease">
      <div className="meridian-lease-line__head">
        <span className="meridian-lease-line__holder">
          <ParticipantMarkDot mark={holderMark} />
          <Chip tone={chip.tone} label={chip.label} />
          <HolderName
            holding={state.holding}
            participantId={state.holderParticipantId}
            mark={holderMark}
          />
        </span>
        <div className="meridian-lease-line__controls">
          {viewerIdentity.status === "read" ? (
            <button
              type="button"
              className="meridian-lease-line__claim"
              onClick={isHeldByViewer ? claim.release : claim.acquire}
              disabled={claim.isInFlight}
            >
              {isHeldByViewer ? "Release the shell" : "Claim the shell"}
            </button>
          ) : null}
          <button
            type="button"
            className="meridian-lease-line__disclosure"
            onClick={onToggleLedger}
            aria-expanded={isLedgerOpen}
          >
            Transitions <DerivedFigure text={formatCount(state.transitionCount)} />
          </button>
        </div>
      </div>

      <WithheldClaimControl viewerIdentity={viewerIdentity} />

      {isHolderHealthUnread ? (
        <Nothing
          kind="not-checked"
          placement="inline"
          title="Node health not read"
          detail="The console has not read the roster, so it cannot say whether the holding node is reachable. A holder shown here is the one the log named."
        />
      ) : null}

      {state.unvouchedNodeId === undefined ? null : (
        <p className="meridian-lease-line__degraded">
          The holding node <WireFigure value={state.unvouchedNodeId} /> is offline, so the shell
          reads as free and stays read-only here.
        </p>
      )}

      {state.unreadTransition === undefined ? null : (
        <p className="meridian-lease-line__unread">
          The shell changed hands under a transition this build cannot read, so nobody is shown as
          holding it and the surface stays read-only.
          {state.unreadTransition.reason === undefined ? null : (
            <>
              {" "}
              The wire called it <WireFigure value={state.unreadTransition.reason} />.
            </>
          )}
        </p>
      )}

      {claim.refusal === undefined ? null : (
        <InlineRefusal code={claim.refusal.code} detail={claim.refusal.detail} />
      )}

      <p className="meridian-lease-line__aside">
        Stepping in pauses a run and hands you the conversation. It never moves the keyboard —
        taking the shell is the claim above, and stopping an agent is a run control.
      </p>

      {isLedgerOpen ? <LeaseTransitionLedger state={state} markFor={markFor} /> : null}
    </div>
  );
}

/**
 * What stands where the claim control would be, while the viewer is not known.
 *
 * Two states and two renderings, because they are two different facts under rule 9.
 * A read still in flight is an ABSENCE — nothing has been established yet, which is
 * the `not-loaded` kind of nothing and says so in words. A refused read is a
 * REFUSAL: the wire's own code and sentence, verbatim, with the console's own next
 * move in the primitive's `action` slot rather than folded into the daemon's text.
 *
 * Neither arm guesses a participant and neither leaves a disabled button behind. A
 * control the surface cannot act through is not offered at all — a `disabled` claim
 * would read as "not right now" when the truth is that the console does not know who
 * would be claiming.
 */
function WithheldClaimControl(props: {
  readonly viewerIdentity: TerminalViewerIdentity;
}): React.JSX.Element | null {
  if (props.viewerIdentity.status === "read") {
    return null;
  }
  if (props.viewerIdentity.status === "refused") {
    return (
      <InlineRefusal
        code={props.viewerIdentity.refusal.code}
        detail={props.viewerIdentity.refusal.detail}
        action="Claiming the shell is offered again once the console can say which participant this window is."
      />
    );
  }
  return (
    <Nothing
      kind="not-loaded"
      placement="inline"
      title="Reading who you are"
      detail="Claiming the shell needs to know which participant this window is, because the lease names its holder and the surface would have no way to tell your hold from somebody else's."
    />
  );
}

/** The transition history, one ledger line per transition, newest last. */
function LeaseTransitionLedger(props: {
  readonly state: TerminalLeaseState;
  readonly markFor: LeaseLineProps["markFor"];
}): React.JSX.Element {
  const { state, markFor } = props;
  if (state.transitions.length === 0) {
    return (
      <Nothing
        kind="not-checked"
        placement="surface"
        title="No transition has been read."
        detail="The lease has changed hands zero times since this session's log was opened here. That is not the same as the shell never having moved."
      />
    );
  }
  const labelFor = (participantId: string): string =>
    markFor(participantId)?.displayName ?? participantId;
  return (
    <div className="meridian-lease-line__ledger" role="feed" aria-label="Lease transitions">
      {state.transitions.map((transition) => {
        const actorId = transition.actorId;
        const mark = actorId === undefined ? undefined : markFor(actorId);
        return (
          <LedgerRow
            key={transition.sequence}
            participantHueStep={mark?.hueStep ?? -1}
            ringTreatment={mark?.ringTreatment ?? "solid"}
            occurredAtIso={transition.occurredAtIso}
            actorLabel={mark?.displayName ?? actorId ?? "The daemon"}
            kindLabel={transition.reason}
          >
            <p className="meridian-lease-line__sentence">
              {terminalLeaseTransitionSentence(transition, labelFor)}
            </p>
          </LedgerRow>
        );
      })}
    </div>
  );
}

/** The holder, by name where the wheel knows one and by wire id where it does not. */
function HolderName(props: {
  readonly holding: TerminalLeaseHolding;
  readonly participantId: string | null;
  readonly mark: TerminalParticipantMark | undefined;
}): React.JSX.Element {
  if (props.holding === "not-checked") {
    return <DerivedFigure text="The lease has not been read." />;
  }
  // Before the null-holder arm, which would otherwise render this state as the free
  // lease — the one sentence that is certainly wrong here. The holder is null
  // because the fold refused to guess, not because the wire said nobody holds it.
  if (props.holding === "unrecognized-transition") {
    return <DerivedFigure text="The console cannot read who holds the shell." />;
  }
  if (props.participantId === null) {
    return <DerivedFigure text="Nobody holds the shell." />;
  }
  if (props.holding === "held-by-you") {
    return <DerivedFigure text="You may type into the shared shell." />;
  }
  const displayName = props.mark?.displayName;
  return displayName === undefined ? (
    <span className="meridian-lease-line__holder-id">
      <DerivedFigure text="Held by" /> <WireFigure value={props.participantId} />
    </span>
  ) : (
    <DerivedFigure text={`${displayName} holds the shell.`} />
  );
}

/** Carries the holder's participant hue into the mark's fill. */
interface LeaseMarkStyle extends React.CSSProperties {
  readonly "--meridian-lease-hue": string;
}

/** The holder's identity, as a mark rather than an edge — this is not a row. */
function ParticipantMarkDot(props: {
  readonly mark: TerminalParticipantMark | undefined;
}): React.JSX.Element {
  const className =
    props.mark === undefined
      ? "meridian-lease-line__mark meridian-lease-line__mark--unattributed"
      : `meridian-lease-line__mark meridian-lease-line__mark--${props.mark.ringTreatment}`;
  const style: LeaseMarkStyle | undefined =
    props.mark === undefined
      ? undefined
      : { "--meridian-lease-hue": tokenReference(participantHueTokenName(props.mark.hueStep)) };
  return <span className={className} style={style} aria-hidden="true" />;
}
