// The seam, drawn: one line across the ledger, and every part of it wire-sourced.
//
// WHY THIS EXISTS AS ITS OWN ROW RATHER THAN AS A CARD. A seam is not a message and
// not a receipt — it is a change in the run's condition, and `seams.ts` already
// decomposes it into named parts precisely so that the layout is decided here and
// the meaning is decided there. Before this component, `ledgerWindow.seams` reached
// one consumer (the replay dock's next-seam jump) and no renderer at all, so a
// rollback, a compaction, a provider switch or a blocked run fell through to the
// generic row renderer and read as an ordinary one-line receipt: the boundary
// position, the continuity, the declared losses, the failed switch's reason and the
// blocked-on state were derived on every pass and shown nowhere.
//
// WHERE THE BOUNDARY BETWEEN THIS AND THE ROW SEAT SITS. Seams are the LEDGER's
// rows, not the seat's. The seat (`seats/timeline-row-slot.ts`) is filled
// by whichever renderer owns a session's row BODIES, and a seam has no body: it has
// a glyph, a label, and a handful of wire members laid on one line. So the feed
// dispatches a seam row here BEFORE it delegates to the seat, and the seat contract
// is left exactly as it was — this is a row the ledger draws itself, and widening
// the seat to carry it would make every future row owner responsible for a
// vocabulary that is the ledger's own.
//
// THE FIVE PARTS ARE RENDER HELPERS AND NOT FIVE COMPONENTS. Each is a stateless,
// hook-free fragment of ONE line, rendered from one place, and naming five components
// for five spans of a sentence would put five fibers and five files where the ledger
// has one row. `apps/desktop/AGENTS.md` puts one component in a `.tsx` module and this
// module has one; what sits beside it is the shape `MachineBody.tsx`'s `renderBodyText`
// already uses — a plain function returning markup, called rather than mounted.
//
// NOTHING HERE COMPOSES A SENTENCE. Each part is rendered as itself: the label from
// the binding table, the wire type in mono, the boundary position as a figure, the
// continuity and every declared loss verbatim. A producer that wrote prose here
// would have decided the layout, and a renderer that mapped an unrecognized
// `continuity` or loss value onto a fallback phrase would silently stop reporting
// the newest kind of loss.

import { Glyph, LedgerRow, Nothing } from "../../../primitives/index.js";
import { type ParticipantHueAssignment } from "../../../tokens/index.js";
import { SEAM_WIRE_BINDINGS, SWITCH_CONTINUITY_MEMO, type LedgerSeam } from "./seams.js";

export interface SeamRowProps {
  readonly seam: LedgerSeam;
  /** The actor's allocated hue, or `undefined` on an unattributed seam. */
  readonly participantHue?: ParticipantHueAssignment | undefined;
  /** Whether a rollback later in the log put this seam behind it. */
  readonly isSuperseded?: boolean | undefined;
}

/** One seam, on one line. */
export function SeamRow(props: SeamRowProps): React.JSX.Element {
  const { seam } = props;
  const binding = SEAM_WIRE_BINDINGS[seam.kind];
  return (
    <LedgerRow
      participantHueStep={props.participantHue?.step ?? -1}
      {...(props.participantHue === undefined
        ? {}
        : { ringTreatment: props.participantHue.ringTreatment })}
      occurredAtIso={seam.timestamp}
      actorLabel={seam.actorId ?? "Session"}
      kindLabel={seam.wireType}
      {...(props.isSuperseded === undefined ? {} : { isSuperseded: props.isSuperseded })}
    >
      <p
        className={
          binding.isCaution ? "meridian-seam-row meridian-seam-row--caution" : "meridian-seam-row"
        }
      >
        <Glyph name={binding.glyph} title={binding.label} />
        <span className="meridian-seam-row__label">{binding.label}</span>
        {seamBoundaryPosition(seam)}
        {seamContinuity(seam)}
        {seamReason(seam)}
        {seamBlockedOn(seam)}
      </p>
      {seamWireAbsence(seam)}
    </LedgerRow>
  );
}

/**
 * The boundary the seam landed at, for the two kinds that carry one.
 *
 * Rendered as an ABSENCE where the row named none rather than as a zero: a rewind
 * to turn zero and a rewind whose floor nobody recorded are different facts, and a
 * `0` on screen is indistinguishable between them.
 */
function seamBoundaryPosition(seam: LedgerSeam): React.JSX.Element | null {
  if (seam.kind !== "rollback" && seam.kind !== "compaction") {
    return null;
  }
  if (seam.boundaryPosition === undefined) {
    return (
      <Nothing kind="empty" placement="inline" title="This seam carries no boundary position." />
    );
  }
  return (
    <span className="meridian-seam-row__boundary">
      Boundary <span className="meridian-seam-row__figure">{String(seam.boundaryPosition)}</span>
    </span>
  );
}

/**
 * The switch's continuity, and its loss clause.
 *
 * The clause appears ONLY on the memo arm. `'in_place'` and `'replayed'` render the
 * same line without one, because nothing was lost — and an "and nothing was lost"
 * sentence on those two would be prose this component invented. Every loss is
 * rendered as the string the wire sent; the vocabulary is closed on the wire and
 * widened by amendment, so a mapping onto a fallback phrase here would go quiet on
 * exactly the newest kind of loss.
 */
function seamContinuity(seam: LedgerSeam): React.JSX.Element | null {
  if (seam.continuity === undefined) {
    return null;
  }
  return (
    <span className="meridian-seam-row__continuity">
      <span className="meridian-seam-row__figure">{seam.continuity}</span>
      {seam.continuity === SWITCH_CONTINUITY_MEMO ? (
        <span className="meridian-seam-row__losses">
          {seam.declaredLosses.length === 0 ? (
            <Nothing kind="empty" placement="inline" title="No losses were declared." />
          ) : (
            seam.declaredLosses.map((loss) => (
              <span className="meridian-seam-row__figure" key={loss}>
                {loss}
              </span>
            ))
          )}
        </span>
      ) : null}
    </span>
  );
}

/** The failed switch's reason, verbatim. */
function seamReason(seam: LedgerSeam): React.JSX.Element | null {
  if (seam.kind !== "provider-switch-failed" || seam.reason === undefined) {
    return null;
  }
  return <span className="meridian-seam-row__figure">{seam.reason}</span>;
}

/** Which state a blocked run is waiting on, verbatim. */
function seamBlockedOn(seam: LedgerSeam): React.JSX.Element | null {
  if (seam.blockedOn === undefined) {
    return null;
  }
  return (
    <span className="meridian-seam-row__blocked-on">
      Waiting on <span className="meridian-seam-row__figure">{seam.blockedOn}</span>
    </span>
  );
}

/**
 * The seam whose wire type the registered census does not carry.
 *
 * `not-checked` rather than `empty`: nobody asked the daemon for this and the daemon
 * could not answer if they had, which is a different fact from a served empty
 * reading. A row of this kind can still ARRIVE — `TimelineRow.type` is free-form by
 * contract — and when one does the console draws it and says, on the same line, that
 * its type is not one the contract package registers.
 */
function seamWireAbsence(seam: LedgerSeam): React.JSX.Element | null {
  if (seam.wireRegistration === "registered") {
    return null;
  }
  return (
    <Nothing
      kind="not-checked"
      placement="inline"
      title="This build does not register that event type."
      detail={`${seam.wireType} arrived, and the contract package carries no registration for it, so nothing here was read from a shape this build knows.`}
    />
  );
}
