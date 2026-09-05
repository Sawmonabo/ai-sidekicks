// The part of the cast bar that needs an open store.
//
// Its own module for the one-component rule, and it was already its own component for
// a reason the rule agrees with: a hook cannot run conditionally, so folding this into
// the bar would mean either subscribing to a store that may be `undefined` or
// rendering the session's identity only after the session opened.

import { useMemo } from "react";

import { CAST_BAR_CHIP_CAP } from "../core/index.js";
import { Nothing } from "../primitives/index.js";
import { useSessionStore, type SessionStore } from "../store/index.js";
import { CastChip } from "./CastChip.js";
import { FoldedMembers } from "./FoldedMembers.js";
import { deriveCastBar } from "./cast-bar-model.js";

export interface CastBarBodyProps {
  readonly sessionStore: SessionStore;
  readonly onFollow: (participantId: string) => void;
  readonly onShowMembers?: () => void;
}

/** The members, the fold, and the bar's one all-clear line. */
export function CastBarBody(props: CastBarBodyProps): React.JSX.Element {
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
            Summing the rows here would be the one thing `Spec-023 §Rules every console
            surface obeys` forbids by name: under One accountant, "the renderer never
            sums visible rows". */}
        <Nothing kind="not-checked" title="Session spend" detail="No cost receipt has been read." />
      </span>
    </>
  );
}
