import { createContext, type Context } from "react";

import type { AlignmentWorker } from "./handle.js";

/**
 * The alignment worker of the window the tree below is drawn in, provided by
 * `AlignmentWorkerProvider`; `undefined` outside one, where a diff cannot draw.
 */
export const AlignmentWorkerContext: Context<AlignmentWorker | undefined> = createContext<
  AlignmentWorker | undefined
>(undefined);
