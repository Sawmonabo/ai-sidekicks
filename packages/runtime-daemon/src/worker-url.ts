// Where a worker thread's module sits: beside the module that starts it, with that module's own
// extension, so the same line finds it in the source tree and in the build.

import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The URL of the `worker` module beside the module at `moduleUrl` (its `import.meta.url`), carrying
 * that module's extension, for `new Worker`.
 */
export function workerModuleUrlBeside(moduleUrl: string): URL {
  return new URL(`./worker${path.extname(fileURLToPath(moduleUrl))}`, moduleUrl);
}
