// The window's floor as one hidden box the frame's stylesheet sizes, so the floor main enforces is
// summed by the layout engine at the current text size and title-bar inset.

import type { WindowSize } from "#shared/window/size.js";
import { useReportWindowFloor } from "./hooks/useReportWindowFloor.js";

/** What the floor box sums and reports to. */
export interface WindowFloorProbeProps {
  /** The narrowest one pane may be, in CSS px; the stylesheet adds it to the floor's width. */
  readonly minimumPaneWidthPx: number;
  /** The window's smallest size, in CSS px, on first layout and on every change. */
  readonly onWindowFloorChange: (floor: WindowSize) => void;
}

/** A hidden, out-of-flow box as large as the smallest window the frame fits in. */
export function WindowFloorProbe(props: WindowFloorProbeProps): React.JSX.Element {
  const windowFloorRef = useReportWindowFloor(props.onWindowFloorChange);
  const paneTerm: WindowFloorPaneTerm = {
    "--meridian-frame-minimum-pane-width": `${props.minimumPaneWidthPx}px`,
  };
  return (
    <div
      ref={windowFloorRef}
      className="meridian-frame__window-floor"
      style={paneTerm}
      aria-hidden="true"
    />
  );
}

/** Carries the pane term into the floor box's sheet. */
interface WindowFloorPaneTerm extends React.CSSProperties {
  readonly "--meridian-frame-minimum-pane-width": string;
}
