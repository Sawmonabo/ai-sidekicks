// The replay control, docked over the rail.
//
// THE SHAPE IS THIS CONSOLE'S, because no committed document states it: a scrub-and-play
// control docked over the rail — play and pause, `replay-model.ts`'s three speed presets,
// the current position as a timestamp in mono, and jump-to-next-seam. Its density budget
// is one docked control, hidden until the rail is hovered or a chord opens it, which is
// `Spec-023 §Meridian, the design language` rule 7's "secondary controls live one click
// away … never as a second visible button" applied to a whole control.
//
// THE CONTROL DECIDES NOTHING. Every act goes to `ReplayEngine`, and everything
// rendered is read off `ReplayPosition`. There is no second copy of the state
// here — not a local `isPlaying`, not a remembered speed — because a control that
// remembered either would disagree with the engine the first time playback ended
// on its own.
//
// THE GRANULARITY LABEL IS PART OF THE CONTROL, not a caption someone might add. A
// live replay is re-animated at TURN granularity because the deltas between turns
// were never persisted, and `replay-model.ts`'s fourth rule forbids claiming otherwise. Rendering
// the engine's own `granularity` is what makes that structural.

import { WireFigure, formatClockTime } from "../../../primitives/index.js";
import { Glyph } from "../../../primitives/index.js";
import { GLYPH_SIZE_CHROME } from "../../../tokens/index.js";
import { REPLAY_SPEEDS, type ReplayPosition, type ReplaySpeed } from "./replay-model.js";

export interface ReplayControlsProps {
  readonly position: ReplayPosition;
  /**
   * Whether the control is on screen.
   *
   * The density rule above: the dock is hidden until the rail is hovered or a chord
   * opens it. The caller owns both triggers, because both are facts about the
   * ledger's surface rather than about replay.
   */
  readonly isRevealed: boolean;
  readonly onPlay: () => void;
  readonly onPause: () => void;
  readonly onSpeedChange: (speed: ReplaySpeed) => void;
  readonly onScrub: (elapsedMs: number) => void;
  readonly onJumpToNextSeam: () => void;
  /**
   * Start the replay at the row the reader is looking at — the design's "replay
   * from here", reached from the dock rather than from a row.
   *
   * A ROW-ANCHORED ACT ON A CONTROL THAT IS NOT A ROW, and the reason is ownership
   * rather than taste: a row's body belongs to the timeline row seat, whose props
   * are the row and three list decisions with no callback among them. The dock and
   * the palette are the two surfaces this family owns, and both can name the row in
   * view. The caller resolves which row that is and answers a refusal when there is
   * none, so this control neither reads a window nor decides anything.
   */
  readonly onReplayFromRowInView: () => void;
}

/** What each state's primary control offers. Total over the four states. */
const PRIMARY_ACTION_BY_STATE: Readonly<
  Record<ReplayPosition["state"], { readonly label: string; readonly glyph: "play" | "pause" }>
> = {
  idle: { label: "Play the session back", glyph: "play" },
  playing: { label: "Pause the replay", glyph: "pause" },
  paused: { label: "Resume the replay", glyph: "play" },
  // At the tail there is nothing left to play, so the same control restarts from
  // the head — which is what `ReplayEngine.play()` does from `at-tail`, and the
  // label says so rather than leaving a person to press and find out.
  "at-tail": { label: "Replay from the beginning", glyph: "play" },
};

export function ReplayControls(props: ReplayControlsProps): React.JSX.Element {
  const { position } = props;
  const primary = PRIMARY_ACTION_BY_STATE[position.state];

  return (
    <div
      className="meridian-replay"
      // Hidden rather than unmounted: the control keeps its place in the tab order
      // predictable, and `hidden` is inert to the pointer and to assistive
      // technology alike, which a `visibility` rule alone would not be.
      hidden={!props.isRevealed}
      role="group"
      aria-label="Session replay"
    >
      <button
        type="button"
        className="meridian-replay__primary"
        onClick={position.state === "playing" ? props.onPause : props.onPlay}
        aria-label={primary.label}
      >
        <Glyph name={primary.glyph} size={GLYPH_SIZE_CHROME} />
      </button>

      <div className="meridian-replay__speeds" role="group" aria-label="Replay speed">
        {REPLAY_SPEEDS.map((speed) => (
          <button
            key={speed}
            type="button"
            className="meridian-replay__speed"
            aria-pressed={position.speed === speed}
            onClick={() => {
              props.onSpeedChange(speed);
            }}
          >
            {`${String(speed)}×`}
          </button>
        ))}
      </div>

      <input
        className="meridian-replay__scrub"
        type="range"
        min={0}
        max={position.spanMs}
        value={position.elapsedMs}
        aria-label="Replay position"
        // `valuetext` because the raw millisecond offset is not what a person
        // hears the position as — the timestamp beside it is.
        aria-valuetext={scrubValueText(position)}
        onChange={(event) => {
          props.onScrub(Number(event.currentTarget.value));
        }}
      />

      {position.positionIso === undefined ? null : (
        <WireFigure value={formatClockTime(position.positionIso)} title={position.positionIso} />
      )}

      <button
        type="button"
        className="meridian-replay__seam"
        onClick={props.onJumpToNextSeam}
        aria-label="Jump to the next seam"
      >
        <Glyph name="chevron-right" size={GLYPH_SIZE_CHROME} />
      </button>

      {/* A button and deliberately not a second scrubber: the position has one
          writer on this control, and a second range input would be a second
          record of where the replay is. */}
      <button
        type="button"
        className="meridian-replay__from-here"
        onClick={props.onReplayFromRowInView}
        aria-label="Replay from the row in view"
      >
        <Glyph name="rewind" size={GLYPH_SIZE_CHROME} />
      </button>

      <span className="meridian-replay__granularity">{granularityNote(position)}</span>
    </div>
  );
}

/**
 * What the scrubber announces.
 *
 * The position's own instant, or the fact that there is nothing loaded to scrub —
 * never a bare millisecond count, which names no moment in the session.
 */
function scrubValueText(position: ReplayPosition): string {
  return position.positionIso === undefined
    ? "No rows loaded"
    : formatClockTime(position.positionIso);
}

/**
 * The granularity sentence, composed from the engine's own reading.
 *
 * The live wording is fixed here — "replay, turn granularity" — and a fixture
 * scenario replaying its recorded deltas is the one case that earns the finer
 * claim.
 */
function granularityNote(position: ReplayPosition): string {
  return position.granularity === "turn"
    ? "Replay, turn granularity"
    : "Replay, stream granularity";
}
