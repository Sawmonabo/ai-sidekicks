// One window's clock: the bridge's time and timeouts, with frames from that window's own paint.
// Every window renders from one document's tree, which never paints, so a window's subtree is
// handed a clock whose frames that window paces; a minimized window then pauses only its own
// drawing.

import { useContext, useMemo, type ReactNode } from "react";

import type { FrameScheduling } from "@renderer/lib/clock.js";
import { BridgeContext, type BridgeResolution } from "./bridge-context.js";

/** The props of {@link WindowClockProvider}. */
export interface WindowClockProviderProps {
  /** The window whose paint paces the frames of everything below. */
  readonly frames: FrameScheduling;
  readonly children: ReactNode;
}

/** Hands the tree below it the bridge's clock, its frames paced by `frames`. */
export function WindowClockProvider(props: WindowClockProviderProps): React.JSX.Element {
  const resolution = useContext(BridgeContext);
  const { frames } = props;
  const windowResolution = useMemo(
    (): BridgeResolution | undefined =>
      resolution?.status === "ready"
        ? { ...resolution, clock: resolution.clock.withFrames(frames) }
        : resolution,
    [resolution, frames],
  );
  return <BridgeContext.Provider value={windowResolution}>{props.children}</BridgeContext.Provider>;
}
