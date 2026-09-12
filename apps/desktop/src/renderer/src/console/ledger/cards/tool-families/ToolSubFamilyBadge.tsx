// The fixture shell for the tool sub-family slot — the MCP badge and the argument
// summary, standing in until the six treatments are built.
//
// IT RENDERS NOTHING WHEN NOTHING IS DECLARED, and that is the row-footer rule rather
// than an omission: a pane-sized slot prints the "reserved, not stubbed" sentence
// because a person looking at an empty pane needs to be told the pane is reserved,
// while a marker that repeats once per tool row would print a paragraph of
// unbuilt-feature prose down a log of forty tool calls. The honest reading of an
// undeclared sub-family is the tool layout this console already draws.
//
// AND IT INVENTS NOTHING. Every part below comes off the row's own declared reading:
// the server label where the row names one, the argument summary the daemon composed,
// and the sub-family itself. Nothing is derived from the tool's NAME, which is the
// invention `card-family.ts` refuses and the reason this slot exists at all.
//
// THE UNRECOGNIZED ARM PRINTS WHAT WAS SENT. An unknown enum member renders as the
// explicit unrecognized badge, so a seventh sub-family shipped by a newer daemon reads
// as a value this build does
// not know rather than as no sub-family at all.

import { Chip, WireFigure } from "../../../primitives/index.js";
import { type OwnerSlotProps } from "../../../seats/index.js";
import { type ToolSubFamilyReading, type ToolSubFamilyRenderer } from "./tool-sub-families.js";

export interface ToolSubFamilyBadgeProps {
  /** The slot the six treatments will fill, and the shell that stands in for now. */
  readonly slot: OwnerSlotProps<ToolSubFamilyRenderer>;
  /** What this row declared, or `undefined` where it declared nothing. */
  readonly reading: ToolSubFamilyReading | undefined;
}

/** One row's sub-family treatment: the owner's body, the shell, or nothing at all. */
export function ToolSubFamilyBadge(props: ToolSubFamilyBadgeProps): React.ReactNode {
  const reading = props.reading;
  if (reading === undefined) {
    return null;
  }
  const body = props.slot.body;
  if (body !== undefined) {
    return body({ reading });
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
