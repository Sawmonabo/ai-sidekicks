// The window's one short note that fades: centered at the window's foot, over the content and under
// any dialog, its words said once through the window's announcer as it appears, and never a place
// focus goes. It holds while the pointer is on it and while the window is in the background, and
// carries no control of its own. It joins the window's airspace, so a native page view under it
// yields. A caller mounts one per note, keyed on it, so a new note replaces the one showing with a
// fresh time.

import { useState } from "react";

import { useAnnounceWhenChanged } from "#renderer/hooks/announce/useAnnounceWhenChanged.js";
import { useAirspaceRegistration } from "#renderer/hooks/useAirspaceRegistration.js";
import type { Clock } from "#renderer/lib/clock.js";
import { useIsNoteFading } from "./hooks/useIsNoteFading.js";

import "./FadingNote.css";

/** Props for `FadingNote`. */
export interface FadingNoteProps {
  readonly words: string;
  /** How long the note stays while nothing holds it, in milliseconds. */
  readonly durationMs: number;
  /** Whether the window is in front; behind, the note's time stops. */
  readonly isWindowFocused: boolean;
  /** The window's clock, so a fixture window's note waits on the frozen one. */
  readonly clock: Clock;
  /** Called once the note has faded out. */
  readonly onGone: () => void;
}

/** One note at the window's foot that stays its time and fades. */
export function FadingNote(props: FadingNoteProps): React.JSX.Element {
  const airspaceRef = useAirspaceRegistration();
  const [isPointerOn, setIsPointerOn] = useState(false);
  const isFading = useIsNoteFading(
    props.clock,
    props.durationMs,
    isPointerOn || !props.isWindowFocused,
    props.onGone,
  );
  useAnnounceWhenChanged(props.words, "polite");
  return (
    <p
      ref={airspaceRef}
      className="meridian-fading-note"
      data-fading={isFading ? "" : undefined}
      onPointerEnter={() => {
        setIsPointerOn(true);
      }}
      onPointerLeave={() => {
        setIsPointerOn(false);
      }}
    >
      {props.words}
    </p>
  );
}
