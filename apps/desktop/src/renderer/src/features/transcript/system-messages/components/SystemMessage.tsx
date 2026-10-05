// The system message, drawn: one line across the transcript naming the act, never the actor. The
// feed dispatches a system message here before the row renderer, which draws row bodies; a system
// message has only a glyph and the act's name from the binding table.

import { Glyph } from "#renderer/components/Glyph/Glyph.js";
import {
  TranscriptRowLayout,
  hueStepOf,
} from "../../components/TranscriptRowLayout/TranscriptRowLayout.js";
import { type AgentHueAssignment } from "#renderer/styles/agent-hue.js";
import { SYSTEM_MESSAGE_BINDINGS } from "../system-message-kinds.js";
import { type SystemMessageReading } from "../system-message-classifier.js";

import "./system-messages.css";

/** Props for `SystemMessage`. */
export interface SystemMessageProps {
  readonly systemMessage: SystemMessageReading;
  /** The actor's allocated hue, or `undefined` on an unattributed row. */
  readonly agentHue?: AgentHueAssignment | undefined;
  /** Whether a rollback later in the log put this system message behind it. */
  readonly isSuperseded?: boolean | undefined;
}

/** One system message, on one line. */
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
        <Glyph name={binding.glyph} title={binding.label} />
        <span className="meridian-system-message__label">{binding.label}</span>
      </p>
    </TranscriptRowLayout>
  );
}
