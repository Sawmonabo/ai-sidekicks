// The cast bar: everyone in the session, and what each of them is doing.
//
// `Spec-023 §Console Design (Meridian)` §4.1 — "Show every participant, human and
// sidekick, as a live chip with a present-tense verb, and make each chip a way to
// follow that actor."
//
// WHAT IT RENDERS AND WHAT IT REFUSES TO. The identity, the six-value session state
// verbatim, one chip per participant in join-log order, the fold to "+N" past the
// chip cap, and the all-clear line. It renders no verb it did not derive from a
// registered event kind, no colour that means urgency (the hue answers "who", and
// amber and red live on the rows), and no spend figure of its own — the receipt's
// value or nothing.
//
// THREE THINGS THE DESIGN NAMES THAT THE WIRE DOES NOT HAVE, rendered as absences
// rather than invented:
//
//   • **Liveness.** `@ai-sidekicks/contracts` registers four presence states and a
//     read that carries them, but nothing in the console subscribes to one yet and
//     the growth port has no presence operation. So the presence glyph renders the
//     "not checked" kind of nothing rather than a green dot nobody measured.
//   • **The terminal lease.** No `controlHolder` member is registered anywhere in
//     the contracts package, so no lease glyph is drawn.
//   • **The committed spend.** The cost receipt is not a wire the console has. The
//     all-clear line therefore ends at its sentence, and the figure's absence is
//     drawn as an absence.
//
// The bar is one line and every verb truncates to one clause, which is a CSS
// property here rather than a string operation: truncating in JavaScript would put a
// wire-derived string through a transformation the figure rules forbid.

import { useMemo } from "react";

import { CAST_BAR_CHIP_CAP } from "../core/index.js";
import { Chip, Glyph, Nothing, WireFigure } from "../primitives/index.js";
import { useSessionStore, type SessionStore } from "../store/index.js";
import { tokenReference } from "../tokens/index.js";
import { castChipAccessibleName, deriveCastBar, type CastMember } from "./cast-bar-model.js";

const PRESENCE_GLYPH_SIZE = 10;

/** Carries one participant's hue into the chip's ring, without a style attribute per rule. */
interface CastChipStyle extends React.CSSProperties {
  readonly "--meridian-cast-hue": string;
}

export interface CastBarProps {
  /** `undefined` on a route that names no session — rendered as an absence. */
  readonly sessionId: string | undefined;
  /** `undefined` while the session's store has not opened — the loading arm. */
  readonly sessionStore: SessionStore | undefined;
  /** Follow this actor: focus their pane, scroll the ledger to their latest row. */
  readonly onFollow: (participantId: string) => void;
  /** Open the members section. Absent, the "+N" fold renders as a count only. */
  readonly onShowMembers?: () => void;
}

export function CastBar(props: CastBarProps): React.JSX.Element {
  return (
    <header className="meridian-cast-bar" aria-label="Session cast">
      <span className="meridian-cast-bar__identity">
        {/* The display title `Spec-023 §Console Design (Meridian)` §4.1 asks for
            comes from `SessionSnapshot.metadata`, which no wire the console holds
            carries — so the identity is the short id alone, in mono, rather than a
            title invented beside it. */}
        {props.sessionId === undefined ? (
          <Nothing kind="empty" title="No session" />
        ) : (
          <WireFigure value={props.sessionId} title="Session id" />
        )}
      </span>
      {props.sessionStore === undefined ? (
        <Nothing kind="not-loaded" title="This session is opening." />
      ) : (
        <CastBarBody
          sessionStore={props.sessionStore}
          onFollow={props.onFollow}
          {...(props.onShowMembers === undefined ? {} : { onShowMembers: props.onShowMembers })}
        />
      )}
    </header>
  );
}

interface CastBarBodyProps {
  readonly sessionStore: SessionStore;
  readonly onFollow: (participantId: string) => void;
  readonly onShowMembers?: () => void;
}

/**
 * The part that needs an open store.
 *
 * Split out because a hook cannot run conditionally: the bar renders its identity
 * before a store exists, and folding the two into one component would mean either
 * subscribing to a store that may be `undefined` or rendering the identity only
 * after the session opened.
 */
function CastBarBody(props: CastBarBodyProps): React.JSX.Element {
  const timeline = useSessionStore(props.sessionStore, (state) => state.timeline);
  const degradedCause = useSessionStore(props.sessionStore, (state) => state.degradedCause);
  const hueAllocator = props.sessionStore.hueAllocator;

  // Derived under `useMemo` rather than inside the selector: a selector that BUILT
  // a value would defeat zustand's `Object.is` comparison and re-render the bar
  // every frame, which is the one thing `store/hooks.ts` asks callers not to do.
  const model = useMemo(
    () =>
      deriveCastBar({
        assignments: hueAllocator.assignments(),
        timeline,
        isDegraded: degradedCause !== undefined,
        chipCap: CAST_BAR_CHIP_CAP,
      }),
    [hueAllocator, timeline, degradedCause],
  );

  if (model.members.length === 0) {
    return (
      <Nothing
        kind="empty"
        title="Nobody has joined this session yet."
        detail="Participants appear here as they join and as agents are attached."
      />
    );
  }

  return (
    <>
      <ul className="meridian-cast-bar__members">
        {model.members.map((member) => (
          <li key={member.participantId}>
            <CastChip member={member} onFollow={props.onFollow} />
          </li>
        ))}
      </ul>
      {model.foldedMemberCount === 0 ? null : (
        <FoldedMembers
          count={model.foldedMemberCount}
          {...(props.onShowMembers === undefined ? {} : { onShowMembers: props.onShowMembers })}
        />
      )}
      <span className="meridian-cast-bar__all-clear">
        {model.isAllClear ? (
          <span className="meridian-cast-bar__all-clear-line">Nothing needs you.</span>
        ) : null}
        {/* The receipt is the only source of a spend figure and the console has no
            read for it, so the figure is drawn as the "not checked" kind of nothing.
            Summing the rows here would be the one thing §4.1 forbids by name. */}
        <Nothing kind="not-checked" title="Session spend" detail="No cost receipt has been read." />
      </span>
    </>
  );
}

interface CastChipProps {
  readonly member: CastMember;
  readonly onFollow: (participantId: string) => void;
}

/**
 * One participant.
 *
 * A `<button>` because clicking it performs an act — follow — and a `<div>` with a
 * click handler is an act nobody can reach with a keyboard. The accessible name is
 * built from the identifier and the verb, so a screen reader hears "priya, waiting
 * on approval" rather than "button" — composed in the model and set as the button's
 * own label, because the presence glyph is an image with a name and concatenation
 * would put "Presence has not been read" in front of every person in the session.
 *
 * The visible name is the one the WIRE gave this participant — a membership beat's
 * identity handle, an agent's attached name — and the id when the log named none.
 * The id stays reachable as the name's tooltip: two participants admitted in the
 * same millisecond share a UUID prefix long enough that the chip's own ellipsis
 * truncates both to the same string, so the id alone identifies nobody.
 */
function CastChip(props: CastChipProps): React.JSX.Element {
  const { member } = props;
  const style: CastChipStyle = { "--meridian-cast-hue": tokenReference(member.hue.tokenName) };

  return (
    <button
      type="button"
      className="meridian-cast-chip"
      style={style}
      data-ring={member.hue.ringTreatment}
      data-shares-step={member.hue.sharesStepWithEarlierParticipant}
      aria-label={castChipAccessibleName(member)}
      onClick={() => {
        props.onFollow(member.participantId);
      }}
    >
      {/* Presence is not a wire the console has. The glyph is drawn in the
          not-checked treatment rather than as a state, because "we have not asked"
          and "they are online" are different facts. */}
      <Glyph name="dot" size={PRESENCE_GLYPH_SIZE} title="Presence has not been read" />
      <span
        className="meridian-cast-chip__name"
        title={member.label === undefined ? undefined : member.participantId}
      >
        <WireFigure value={member.label ?? member.participantId} />
      </span>
      {member.verb === undefined ? null : (
        <span className="meridian-cast-chip__verb" data-stale={member.isVerbStale}>
          {member.verb}
        </span>
      )}
    </button>
  );
}

interface FoldedMembersProps {
  readonly count: number;
  readonly onShowMembers?: () => void;
}

/**
 * The "+N" fold.
 *
 * A button when somebody can open the members section and a plain count when nobody
 * can — the absent-not-disabled rule again. Rendered through `Chip` in mono, because
 * the number is derived rather than wire-verbatim and the primitive is what carries
 * that distinction.
 */
function FoldedMembers(props: FoldedMembersProps): React.JSX.Element {
  const label = `+${String(props.count)}`;
  if (props.onShowMembers === undefined) {
    return (
      <span className="meridian-cast-bar__fold">
        <Chip label={label} />
      </span>
    );
  }
  return (
    <button
      type="button"
      className="meridian-cast-bar__fold"
      onClick={props.onShowMembers}
      aria-label={`Show the other ${String(props.count)} participants`}
    >
      <Chip label={label} />
    </button>
  );
}
