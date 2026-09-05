// The ledger's right-hand column: the provenance rail, and the replay dock the rail
// reveals.
//
// ITS OWN MODULE BECAUSE THE REVEAL IS A PROPERTY OF THIS COLUMN. The dock is hidden
// until the rail is hovered or focused — both facts about this strip rather than
// about replay — so the four handlers that decide it and the two children they
// govern belong to one component. Split across the composition they came from, a
// reader had to hold a `<div>`'s pointer handlers and a dock's eight callbacks in
// mind at once to see that the second is revealed by the first.
//
// THE ASYMMETRY IN THE FOUR HANDLERS IS DELIBERATE and is the reason they are here
// rather than defaulted: `onPointerLeave` is unguarded because React's leave events
// do not fire for a pointer move between two elements inside this subtree, while the
// focus pair IS guarded — a blur into a child of this column is not a departure.

import {
  ProvenanceRail,
  ReplayControls,
  ProvenanceRailModel,
  type RailViewportBand,
} from "../../ledger/structure/index.js";
import { type ConsoleClock } from "../../core/index.js";
import { type ParticipantHueAssignment } from "../../tokens/index.js";
import { type LedgerReplayState } from "./ledger-replay-window.js";

export interface LedgerFeedRailProps {
  readonly railModel: ProvenanceRailModel;
  /** Where the reading position sits in the window, and how much of it is covered. */
  readonly geometry: RailViewportBand;
  /** Whether the viewport is pinned to the tail, which the rail draws differently. */
  readonly isFollowing: boolean;
  /** The ledger's one scroll writer, handed down so the rail holds no second. */
  readonly onJumpToRow: (rowId: string) => void;
  /** The SESSION's wheel, so one person wears one colour on the rail and in the rows. */
  readonly hueForActor: (participantId: string) => ParticipantHueAssignment | undefined;
  readonly clock: ConsoleClock;
  readonly replay: LedgerReplayState;
  /** Conceal the dock only for a focus move that really left this column. */
  readonly onFocusLeaving: (event: React.FocusEvent<HTMLDivElement>) => void;
  /**
   * The act the palette runs, not a second copy.
   *
   * The refusal for an absent anchor lives inside it, so a control with its own
   * callback would be a second place this console decides what to say.
   */
  readonly onReplayFromRowInView: () => void;
}

export function LedgerFeedRail(props: LedgerFeedRailProps): React.JSX.Element {
  const { replay } = props;
  return (
    <div
      className="meridian-ledger__rail"
      onPointerEnter={replay.reveal}
      onPointerLeave={replay.conceal}
      // Reveal needs no guard of its own — it is idempotent, and a focus move
      // arriving from anywhere is a reason for the dock to be on screen.
      onFocus={replay.reveal}
      onBlur={props.onFocusLeaving}
    >
      <ProvenanceRail
        model={props.railModel}
        viewportPosition={props.geometry.position}
        viewportExtent={props.geometry.extent}
        isFollowing={props.isFollowing}
        onJumpToRow={props.onJumpToRow}
        hueForActor={props.hueForActor}
        clock={props.clock}
      />
      <ReplayControls
        position={replay.position}
        isRevealed={replay.isRevealed}
        onPlay={replay.play}
        onPause={replay.pause}
        onSpeedChange={replay.setSpeed}
        onScrub={replay.scrub}
        onJumpToNextSeam={replay.jumpToNextSeam}
        onReplayFromRowInView={props.onReplayFromRowInView}
      />
    </div>
  );
}
