// Where a worker's module sits, for a worker thread or a child process: beside the module that
// starts it, with that module's own extension, so the same line finds it in the source tree and in
// the build.

import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The URL of the module named `moduleName` beside the module at `moduleUrl` (its
 * `import.meta.url`), carrying that module's extension, for `new Worker` or `fork`.
 */
export function moduleUrlBeside(moduleUrl: string, moduleName: string): URL {
  return new URL(`./${moduleName}${path.extname(fileURLToPath(moduleUrl))}`, moduleUrl);
}
