import { createContext, type Context } from "react";

import { type ViewportSelectionTracker } from "./tracker.js";

/**
 * The selection tracker of the viewport a row renders in, provided by `TranscriptViewport`.
 * `undefined` outside one, which `useViewportSelectionTracker` refuses.
 */
export const ViewportSelectionTrackerContext: Context<ViewportSelectionTracker | undefined> =
  createContext<ViewportSelectionTracker | undefined>(undefined);
