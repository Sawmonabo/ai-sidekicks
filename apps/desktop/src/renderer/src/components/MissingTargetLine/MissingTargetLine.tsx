// The one line a pointer to something gone draws, `Message not found` or `Session not found`: on
// the control pressed when it is in view, else in the place `Jump to latest` takes. It is said
// politely without taking focus and drawn without motion.

import "./MissingTargetLine.css";

import { AnnouncedLine } from "#renderer/components/AnnouncedLine/AnnouncedLine.js";

/** What a pointer named that is gone: a row of the conversation, or a whole session. */
export type MissingTarget = "message" | "session";

/** Props for `MissingTargetLine`. */
export interface MissingTargetLineProps {
  readonly target: MissingTarget;
  /** The raise this line answers, so the same line raised again by a new press is said again. */
  readonly raisedKey: string;
}

/** The line saying a pointer's target is gone. */
export function MissingTargetLine(props: MissingTargetLineProps): React.JSX.Element {
  return (
    <AnnouncedLine
      element="p"
      className="meridian-missing-target-line"
      words={MISSING_TARGET_WORDS[props.target]}
      politeness="polite"
      attempt={props.raisedKey}
    />
  );
}

const MISSING_TARGET_WORDS: Readonly<Record<MissingTarget, string>> = {
  message: "Message not found",
  session: "Session not found",
};
