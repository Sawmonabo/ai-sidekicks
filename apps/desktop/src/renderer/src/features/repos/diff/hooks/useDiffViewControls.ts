import { useCallback, useState } from "react";

import { type DiffViewMode } from "../diff-model.js";

/** What the view control holds, and the setter that moves it. */
export interface DiffViewControls {
  readonly viewMode: DiffViewMode;
  toggleViewMode(): void;
}

/** Hold the split/unified view control. */
export function useDiffViewControls(): DiffViewControls {
  const [viewMode, setViewMode] = useState<DiffViewMode>("unified");

  const toggleViewMode = useCallback(() => {
    setViewMode((previous) => (previous === "unified" ? "split" : "unified"));
  }, []);

  return { viewMode, toggleViewMode };
}
