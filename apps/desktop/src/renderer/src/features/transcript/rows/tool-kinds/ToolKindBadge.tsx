// The tool kind badge: the MCP server and the argument summary, from the row's declared reading
// and never from the tool's name. The kind itself is wire spelling and is not drawn. It renders
// nothing when the row declares nothing or declares a kind this build does not know.

import { Fragment } from "react";

import { WireFigure } from "#renderer/components/WireFigure/WireFigure.js";
import { type ToolKindReading } from "./vocabulary.js";

import "./ToolKindBadge.css";

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
  // The spaces draw nothing between flex items; they keep the figures, and the summary after the
  // badge, apart in text copied out of the row.
  return (
    <span className="meridian-tool-kind-badge">
      {reading.serverLabel === undefined ? null : (
        <>
          <WireFigure value={reading.serverLabel} hoverLabel="Server" />{" "}
        </>
      )}
      {reading.argumentSummary.map((argument) => (
        <Fragment key={argument}>
          <WireFigure value={argument} hoverLabel="Argument" />{" "}
        </Fragment>
      ))}
    </span>
  );
}
