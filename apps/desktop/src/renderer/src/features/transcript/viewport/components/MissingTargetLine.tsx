// The one line a pointer to something gone draws in place of `Jump to latest`, such as
// `Message not found`: said politely without taking focus, and drawn without motion.

import { AnnouncedLine } from "#renderer/components/AnnouncedLine/AnnouncedLine.js";

/** Props for `MissingTargetLine`. */
export interface MissingTargetLineProps {
  /** The line's words. */
  readonly words: string;
}

/** The line in the place `Jump to latest` takes, which stays away while the line stands. */
export function MissingTargetLine(props: MissingTargetLineProps): React.JSX.Element {
  return (
    <div className="meridian-transcript-viewport__tail">
      <AnnouncedLine
        element="p"
        className="meridian-transcript-viewport__missing-target"
        words={props.words}
        politeness="polite"
      />
    </div>
  );
}
