// The one edge into the graph renderer's code, and the only asynchronous one. The chunk entry,
// `RunGraphCanvas.tsx`, pulls in `@xyflow/react` and both sheets, which the initial-bundle
// budget excludes, so it is reached through `import()` alone.

import { MemoizedLoad } from "@renderer/lib/memoized-load.js";

/**
 * What a caller gets: the canvas component, and nothing else.
 *
 * Narrowed from the entry module's own shape so a rename there fails here. `typeof import()` in
 * a type position is erased, so it opens no runtime edge into the chunk.
 */
export type RunGraphModule = Pick<typeof import("./RunGraphCanvas.js"), "RunGraphCanvas">;

/**
 * The graph chunk's loader: one fetch per page, however many graphs ask, so two graphs mounting
 * together share one fetch.
 */
export const runGraphLoader: MemoizedLoad<RunGraphModule> = new MemoizedLoad(async () => {
  const { RunGraphCanvas } = await import("./RunGraphCanvas.js");
  return { RunGraphCanvas };
});
