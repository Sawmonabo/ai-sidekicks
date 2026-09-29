// The tool kind badge: the MCP badge and the argument summary.
//
// It renders nothing when nothing is declared: a marker repeated once per tool row would
// print a paragraph of unbuilt-feature prose down a log of forty tool calls, and the
// honest reading of an undeclared tool kind is the tool layout this console already
// draws.
//
// It invents nothing. Every part comes off the row's own declared reading: the server
// label where the row names one, the argument summary the daemon composed, and the
// tool kind itself. Nothing is derived from the tool's NAME, which `row-kind.ts`
// refuses to do.
//
// The unrecognized arm prints what was sent, so a seventh tool kind shipped by a newer
// daemon reads as a value this build does not know rather than as no tool kind at all.

import { Chip, WireFigure } from "@renderer/console/primitives/index.js";
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
