// The tool kind badge: the MCP server and the argument summary, from the row's declared reading
// and never from the tool's name. The kind itself is wire spelling and is not drawn. It renders
// nothing when the row declares nothing or declares a kind this build does not know.

import { WireFigure } from "#renderer/components/WireFigure/WireFigure.js";
import { type ToolKindReading } from "./tool-kinds.js";

import "./tool-kinds.css";

/** What a tool card hands the tool kind badge. */
export interface ToolKindBadgeProps {
  /** What this row declared, or `undefined` where it declared nothing. */
  readonly reading: ToolKindReading | undefined;
}

/** One row's tool kind treatment: the server and argument summary, or nothing at all. */
export function ToolKindBadge(props: ToolKindBadgeProps): React.ReactNode {
  const reading = props.reading;
  if (reading === undefined || reading.kind === "unrecognized") {
    return null;
  }
  return (
    <span className="meridian-tool-kind-badge">
      {reading.serverLabel === undefined ? null : (
        <WireFigure value={reading.serverLabel} title="Server" />
      )}
      {reading.argumentSummary.map((argument) => (
        <WireFigure key={argument} value={argument} title="Argument" />
      ))}
    </span>
  );
}
