// The seam, drawn: one line across the transcript, every part wire-sourced.
// The feed dispatches a seam row here before the row renderer, which draws row bodies; a seam
// has only a glyph, a label and a few wire members. Parts are rendered as themselves (label
// from the binding table, wire type in mono, continuity and losses verbatim), so an
// unrecognized value is still reported rather than mapped onto a fallback phrase.

import { Glyph } from "@renderer/components/Glyph/Glyph.js";
import { TranscriptRowLayout } from "../../components/TranscriptRowLayout/TranscriptRowLayout.js";
import { Nothing } from "@renderer/components/Nothing/Nothing.js";
import { type AgentHueAssignment } from "@renderer/styles/agent-hue.js";
import { SYSTEM_MESSAGE_BINDINGS } from "../system-message-kinds.js";
import { type SystemMessageReading } from "../system-message-classifier.js";

import "./system-messages.css";

/** Props for `SystemMessage`. */
export interface SystemMessageProps {
  readonly seam: SystemMessageReading;
  /** The actor's allocated hue, or `undefined` on an unattributed seam. */
  readonly actorHue?: AgentHueAssignment | undefined;
  /** Whether a rollback later in the log put this seam behind it. */
  readonly isSuperseded?: boolean | undefined;
}

/** One seam, on one line. */
export function SystemMessage(props: SystemMessageProps): React.JSX.Element {
  const { seam } = props;
  const binding = SYSTEM_MESSAGE_BINDINGS[seam.kind];
  return (
    <TranscriptRowLayout
      agentHueStep={props.actorHue?.step ?? -1}
      occurredAtIso={seam.timestamp}
      authorLabel={seam.actorId ?? "Session"}
      kindLabel={seam.wireType}
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
        {seamBoundaryPosition(seam)}
        {seamContinuity(seam)}
        {seamReason(seam)}
      </p>
    </TranscriptRowLayout>
  );
}

/**
 * The boundary the seam landed at, for the two kinds that carry one. Absent renders as an
 * explicit empty marker, not `0`: a rewind to turn zero differs from one with no recorded floor.
 */
function seamBoundaryPosition(seam: SystemMessageReading): React.JSX.Element | null {
  if (seam.kind !== "rollback" && seam.kind !== "compaction") {
    return null;
  }
  if (seam.boundaryPosition === undefined) {
    return (
      <Nothing kind="empty" placement="inline" title="This seam carries no boundary position." />
    );
  }
  return (
    <span className="meridian-system-message__boundary">
      Boundary{" "}
      <span className="meridian-system-message__figure">{String(seam.boundaryPosition)}</span>
    </span>
  );
}

/**
 * The switch's continuity and declared losses. An empty list is the switch's claim that nothing
 * was lost, so it draws no clause. Losses render verbatim so a newly added kind is not hidden.
 */
function seamContinuity(seam: SystemMessageReading): React.JSX.Element | null {
  if (seam.continuity === undefined) {
    return null;
  }
  return (
    <span className="meridian-system-message__continuity">
      <span className="meridian-system-message__figure">{seam.continuity}</span>
      {seam.declaredLosses.length > 0 ? (
        <span className="meridian-system-message__losses">
          {seam.declaredLosses.map((loss) => (
            <span className="meridian-system-message__figure" key={loss}>
              {loss}
            </span>
          ))}
        </span>
      ) : null}
    </span>
  );
}

/** The failed switch's reason, verbatim. */
function seamReason(seam: SystemMessageReading): React.JSX.Element | null {
  if (seam.kind !== "provider-switch-failed" || seam.reason === undefined) {
    return null;
  }
  return <span className="meridian-system-message__figure">{seam.reason}</span>;
}
