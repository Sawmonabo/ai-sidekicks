import { useEffect, useLayoutEffect, useState } from "react";

import { ReorderDrag, type ReorderAxis } from "@renderer/lib/reorder-drag.js";
import { CHROME_SETTLE_EASING, MOTION_DURATIONS_MS } from "@renderer/styles/motion.js";
import { useLatestRef } from "./useLatestRef.js";

/** How long a reorder glide runs: the chrome's settle. */
const REORDER_GLIDE_MS = MOTION_DURATIONS_MS["motion-settle"] ?? 0;

/**
 * Holds one list's pointer reorder for the component's lifetime. `keys` is the order the component
 * draws, handed over after every render; `onReorder` commits a move, once per drag, on release.
 * A press or drag still running when the component unmounts ends without committing.
 */
export function useReorderDrag<Key extends string>(
  axis: ReorderAxis,
  keys: readonly Key[],
  onReorder: (key: Key, toIndex: number) => void,
): ReorderDrag<Key> {
  const latestOnReorder = useLatestRef(onReorder);
  const [drag] = useState(
    () =>
      new ReorderDrag<Key>({
        axis,
        glideMs: REORDER_GLIDE_MS,
        glideEasing: CHROME_SETTLE_EASING,
        onReorder: (key, toIndex) => {
          latestOnReorder.current(key, toIndex);
        },
      }),
  );
  // Layout, not passive: a committed move settles before the new order is painted.
  useLayoutEffect(() => {
    drag.setOrder(keys);
  }, [drag, keys]);
  useEffect(
    () => () => {
      drag.cancel();
    },
    [drag],
  );
  return drag;
}
