// The system message, drawn: one line across the transcript naming the act, never the actor, and
// under a turn a provider process's end cut, the last lines it printed. The feed dispatches a
// system message here before the row renderer, which draws row bodies; a system message has only
// the words its classifier read.

import {
  TranscriptRowLayout,
  hueStepOf,
} from "../../components/TranscriptRowLayout/TranscriptRowLayout.js";
import { type AgentHueAssignment } from "#renderer/styles/agent-hue.js";
import { SYSTEM_MESSAGE_BINDINGS } from "../kinds.js";
import { type SystemMessageReading } from "../classifier.js";

import "./SystemMessage.css";

/** Props for `SystemMessage`. */
export interface SystemMessageProps {
  readonly systemMessage: SystemMessageReading;
  /** The actor's allocated hue, or `undefined` on an unattributed row. */
  readonly agentHue?: AgentHueAssignment | undefined;
  /** Whether a rollback later in the log put this system message behind it. */
  readonly isSuperseded?: boolean | undefined;
}

/** One system message, on one line, over the last lines a dead provider process printed. */
export function SystemMessage(props: SystemMessageProps): React.JSX.Element {
  const binding = SYSTEM_MESSAGE_BINDINGS[props.systemMessage.kind];
  return (
    <TranscriptRowLayout
      agentHueStep={hueStepOf(props.agentHue)}
      occurredAtIso={props.systemMessage.timestamp}
      {...(props.isSuperseded === undefined ? {} : { isSuperseded: props.isSuperseded })}
    >
      <p
        className={
          binding.isCaution
            ? "meridian-system-message meridian-system-message--caution"
            : "meridian-system-message"
        }
      >
        <span className="meridian-system-message__label">{props.systemMessage.label}</span>
      </p>
      {props.systemMessage.lastLines === undefined ? null : (
        <pre className="meridian-system-message__last-lines">{props.systemMessage.lastLines}</pre>
      )}
    </TranscriptRowLayout>
  );
}
