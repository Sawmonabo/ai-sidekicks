import { useRootFontSizePx } from "#renderer/hooks/useRootFontSizePx.js";
import { DIFF_ROW_HEIGHT_REM } from "../measures.js";

/**
 * One diff row's height at the current `Text size`, in CSS pixels: the row's rem height at the
 * root font size of the window the rows are drawn in.
 */
export function useDiffRowHeightPx(): number {
  return DIFF_ROW_HEIGHT_REM * useRootFontSizePx();
}
