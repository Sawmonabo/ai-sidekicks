// The tool kind badge: the MCP badge and the argument summary, all from the row's declared
// reading and never from the tool's name. It renders nothing when the row declares nothing.
// An unrecognized value prints what was sent, so a newer daemon's tool kind reads as unknown
// rather than as no tool kind.

import { Chip } from "@renderer/components/Chip/Chip.js";
import { WireFigure } from "@renderer/components/WireFigure/WireFigure.js";
import { type ToolKindReading, type ToolKindRenderer } from "./tool-kinds.js";

import "./tool-kinds.css";

/** What a tool card hands the tool kind badge. */
export interface ToolKindBadgeProps {
  /** A renderer that replaces the badge, or `undefined` while the badge draws itself. */
  readonly body: ToolKindRenderer | undefined;
  /** What this row declared, or `undefined` where it declared nothing. */
  readonly reading: ToolKindReading | undefined;
}

/** One row's tool kind treatment: the supplied renderer, the badge, or nothing at all. */
export function ToolKindBadge(props: ToolKindBadgeProps): React.ReactNode {
  const reading = props.reading;
  if (reading === undefined) {
    return null;
  }
  if (props.body !== undefined) {
    return props.body({ reading });
  }
  if (reading.kind === "unrecognized") {
    return (
      <span className="meridian-tool-kind-badge">
        <Chip label="Unrecognized tool kind" tone="neutral" />
        <WireFigure value={reading.declared} title="Declared tool kind" />
      </span>
    );
  }
  return (
    <span className="meridian-tool-kind-badge">
      <Chip label={reading.toolKind} tone="neutral" />
      {reading.serverLabel === undefined ? null : (
        <WireFigure value={reading.serverLabel} title="Server" />
      )}
      {reading.argumentSummary.map((argument) => (
        <WireFigure key={argument} value={argument} title="Argument" />
      ))}
    </span>
  );
}
