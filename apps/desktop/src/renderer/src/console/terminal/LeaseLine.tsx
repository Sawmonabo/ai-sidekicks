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

import { useCallback, useEffect, useRef, useState } from "react";

import { isConsoleRefusal, type ConsoleRefusal } from "../core/index.js";
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
import {
  terminalLeaseTransitionSentence,
  type TerminalLeaseHolding,
  type TerminalLeaseState,
} from "./lease-model.js";

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
  /** The shared terminal the lease governs. One per session in V1. */
  readonly terminalId: string;
  readonly state: TerminalLeaseState;
  /**
   * How a participant is drawn, or `undefined` for one the wheel has never
   * admitted. Fail-closed by construction: an unknown participant takes the
   * neutral boundary and its wire id rather than somebody else's hue and name.
   */
  readonly markFor: (participantId: string) => TerminalParticipantMark | undefined;
}

/** What the chip says for each holding. Total over the closed set. */
const HOLDING_CHIPS: Readonly<Record<TerminalLeaseHolding, { label: string; tone: ChipTone }>> = {
  "not-checked": { label: "Not checked", tone: "neutral" },
  unheld: { label: "Free", tone: "neutral" },
  "held-by-you": { label: "You hold it", tone: "accent" },
  "held-by-another": { label: "Held", tone: "neutral" },
};

export function LeaseLine(props: LeaseLineProps): React.JSX.Element {
  const { bridge, terminalId, state, markFor } = props;
  const claim = useTerminalLeaseClaim(bridge, terminalId);
  const [isLedgerOpen, setIsLedgerOpen] = useState(false);

  const holderMark =
    state.holderParticipantId === null ? undefined : markFor(state.holderParticipantId);
  const chip = HOLDING_CHIPS[state.holding];
  const isHeldByViewer = state.holding === "held-by-you";

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
          <button
            type="button"
            className="meridian-lease-line__claim"
            onClick={isHeldByViewer ? claim.release : claim.acquire}
            disabled={claim.isInFlight}
          >
            {isHeldByViewer ? "Release the shell" : "Claim the shell"}
          </button>
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

      {state.holderVouching === "not-checked" ? (
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
        const actorId = transition.actorParticipantId;
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

/** What the claim control knows: whether a call is out, and what refused it. */
interface TerminalLeaseClaim {
  readonly isInFlight: boolean;
  readonly refusal: ConsoleRefusal | undefined;
  readonly acquire: () => void;
  readonly release: () => void;
}

/**
 * Call the lease wire and render what it answers — and nothing else.
 *
 * A hook rather than a class because its whole state is two renderer-local values
 * with no logic between them; the moment it acquires a rule, that rule belongs in
 * `lease-model.ts` where the fold can be tested without React.
 *
 * The served arm deliberately sets NO holder. `terminalAcquireWriteLease` answering
 * "served" means the daemon accepted the claim, not that this participant now holds
 * the shell — the holder is the wire field the transition carries, and a surface
 * that moved on the reply would show a keyboard to somebody whose broadcast never
 * arrived.
 */
function useTerminalLeaseClaim(bridge: ConsoleBridge, terminalId: string): TerminalLeaseClaim {
  const [isInFlight, setIsInFlight] = useState(false);
  const [refusal, setRefusal] = useState<ConsoleRefusal | undefined>(undefined);
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      // A reply that lands after the pane closed has nothing to render into, and
      // setting state on an unmounted tree is how a console grows a warning it
      // then learns to ignore.
      isMountedRef.current = false;
    };
  }, []);

  const call = useCallback(
    (operation: "acquire" | "release"): void => {
      setIsInFlight(true);
      setRefusal(undefined);
      const request = { terminalId };
      const pending =
        operation === "acquire"
          ? bridge.growth.terminalAcquireWriteLease(request)
          : bridge.growth.terminalReleaseWriteLease(request);
      void pending
        .then((outcome) => {
          if (!isMountedRef.current) {
            return;
          }
          setRefusal(outcome.status === "unavailable" ? outcome : undefined);
        })
        .catch((error: unknown) => {
          if (!isMountedRef.current) {
            return;
          }
          setRefusal(asRefusal(error));
        })
        .finally(() => {
          if (isMountedRef.current) {
            setIsInFlight(false);
          }
        });
    },
    [bridge, terminalId],
  );

  const acquire = useCallback(() => {
    call("acquire");
  }, [call]);
  const release = useCallback(() => {
    call("release");
  }, [call]);

  return { isInFlight, refusal, acquire, release };
}

/**
 * A thrown value, as the one refusal shape the console renders.
 *
 * The port answers rather than throws, so this arm covers a bridge that rejected —
 * the fixture's unscripted-reply error, or a preload that died mid-call. The
 * message is carried verbatim, because rule 9 forbids paraphrasing what the other
 * side said.
 */
function asRefusal(error: unknown): ConsoleRefusal {
  if (isConsoleRefusal(error)) {
    return error;
  }
  return {
    origin: "terminal-lease",
    code: "lease-call-failed",
    detail: error instanceof Error ? error.message : String(error),
  };
}
