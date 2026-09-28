// The sub-family badge: the MCP badge and the argument summary.
//
// It renders nothing when nothing is declared: a marker repeated once per tool row would
// print a paragraph of unbuilt-feature prose down a log of forty tool calls, and the
// honest reading of an undeclared sub-family is the tool layout this console already
// draws.
//
// It invents nothing. Every part comes off the row's own declared reading: the server
// label where the row names one, the argument summary the daemon composed, and the
// sub-family itself. Nothing is derived from the tool's NAME, which `card-family.ts`
// refuses to do.
//
// The unrecognized arm prints what was sent, so a seventh sub-family shipped by a newer
// daemon reads as a value this build does not know rather than as no sub-family at all.

import { Chip, WireFigure } from "../../../primitives/index.js";
import { type ToolSubFamilyReading, type ToolSubFamilyRenderer } from "./tool-sub-families.js";

/** What a tool card hands the sub-family badge. */
export interface ToolSubFamilyBadgeProps {
  /** A renderer that replaces the badge, or `undefined` while the badge draws itself. */
  readonly body: ToolSubFamilyRenderer | undefined;
  /** What this row declared, or `undefined` where it declared nothing. */
  readonly reading: ToolSubFamilyReading | undefined;
}

/** One row's sub-family treatment: the supplied renderer, the badge, or nothing at all. */
export function ToolSubFamilyBadge(props: ToolSubFamilyBadgeProps): React.ReactNode {
  const reading = props.reading;
  if (reading === undefined) {
    return null;
  }
  if (props.body !== undefined) {
    return props.body({ reading });
  }
  if (reading.kind === "unrecognized") {
    return (
      <span className="meridian-tool-sub-family">
        <Chip label="Unrecognized tool kind" tone="neutral" />
        <WireFigure value={reading.declared} title="Declared tool sub-family" />
      </span>
    );
  }
  return (
    <span className="meridian-tool-sub-family">
      <Chip label={reading.subFamily} tone="neutral" />
      {reading.serverLabel === undefined ? null : (
        <WireFigure value={reading.serverLabel} title="Server" />
      )}
      {reading.argumentSummary.map((argument) => (
        <WireFigure key={argument} value={argument} title="Argument" />
      ))}
    </span>
  );
}
