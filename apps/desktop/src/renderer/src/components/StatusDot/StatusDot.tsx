// A status dot: one of a session's five states as a mark sized from its line's text, with its
// state named in a word on hover. A running or waiting dot steps through an opacity ramp.

import "./StatusDot.css";

import type { SessionActivity } from "@ai-sidekicks/contracts/session/directory";
import { HoverLabel } from "../HoverLabel/HoverLabel.js";

/** The word that names each state, on the dot's hover and at the end of its row's spoken name. */
export const STATUS_DOT_WORDS: Readonly<Record<SessionActivity, string>> = {
  running: "Working",
  waiting: "Waiting on you",
  done: "Done",
  failed: "Failed",
  idle: "Idle",
};

/**
 * The dot for `state`. It is hidden from assistive technology, so the line it sits on speaks the
 * state's word itself.
 */
export function StatusDot(props: { readonly state: SessionActivity }): React.JSX.Element {
  return (
    <HoverLabel text={STATUS_DOT_WORDS[props.state]} textRole="visible-text">
      <span
        className={`meridian-status-dot meridian-status-dot--${props.state}`}
        aria-hidden="true"
      />
    </HoverLabel>
  );
}
