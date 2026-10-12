// The window's floor as one hidden box the frame's stylesheet sizes, so the floor main enforces is
// summed by the layout engine at the current text size and title-bar inset.

import type { WindowSize } from "#shared/window/size.js";
import { useReportWindowFloor } from "./hooks/useReportWindowFloor.js";

/** What the floor box reports to. */
export interface WindowFloorBoxProps {
  /** The window's smallest size, in CSS px, on first layout and on every change. */
  readonly onWindowFloorChange: (floor: WindowSize) => void;
}

/** A hidden, out-of-flow box as large as the smallest window the frame fits in. */
export function WindowFloorBox(props: WindowFloorBoxProps): React.JSX.Element {
  const windowFloorRef = useReportWindowFloor(props.onWindowFloorChange);
  return <div ref={windowFloorRef} className="meridian-frame__window-floor" aria-hidden="true" />;
}
