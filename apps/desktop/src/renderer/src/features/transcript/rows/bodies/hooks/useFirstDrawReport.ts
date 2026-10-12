import { useContext, useLayoutEffect } from "react";

import { MarkdownFirstDrawContext } from "../markdown-first-draw.js";

/** Report to the row that the body has drawn, before the frame that drew it paints. */
export function useFirstDrawReport(hasDrawn: boolean): void {
  const reportDrawn = useContext(MarkdownFirstDrawContext);
  useLayoutEffect(() => {
    if (hasDrawn) {
      reportDrawn?.();
    }
  }, [hasDrawn, reportDrawn]);
}
