// The windowing sub-module door: what a SIBLING inside `primitives/` takes from here.
//
// The windowed row, the marker attributes it writes, and the roving-index hook that
// reaches it — the three names a virtualized list in this console composes so its
// reader is never told the list is as long as the window.
//
// THE SIBLING IS `restore/`. `RestorePathCell.tsx` takes the row's target-props type
// and `WindowedRestorePathList.tsx` takes the row and the hook, which is the whole
// set below. `windowed-row-markers.ts` is absent on purpose: nothing outside this
// directory reads the attribute names, and a family that wants them reads the row.

export { WindowedListRow } from "./WindowedListRow.js";
export type { WindowedRowTargetProps } from "./WindowedListRow.js";
export { useWindowedRovingIndex } from "./windowed-row-index.js";
