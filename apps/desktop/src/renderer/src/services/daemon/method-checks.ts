// The generated checks of the daemon methods a window calls, each method's two loaded on its first
// call and kept, so the page's start carries no check it has not run. A method once loaded
// answers at once, so only its first call waits on its checks.

import { METHOD_CHECK_LOADERS } from "@ai-sidekicks/contracts/method-checks";
import type { SchemaCheck } from "@ai-sidekicks/contracts/schema-check";
import type {
  DaemonParams,
  DaemonResult,
  RegisteredDaemonMethod,
} from "#shared/daemon/method-bindings.js";

/** One method's two generated checks, typed for that method so a passed check narrows. */
export interface MethodChecks<MethodName extends RegisteredDaemonMethod> {
  readonly requestCheck: SchemaCheck<DaemonParams<MethodName>>;
  readonly responseCheck: SchemaCheck<DaemonResult<MethodName>>;
}

/** The checks of each method a window has called, kept once they have loaded. */
export class DaemonMethodChecks {
  readonly #loadedChecks = new Map<RegisteredDaemonMethod, MethodChecks<RegisteredDaemonMethod>>();

  /**
   * `method`'s checks: at once when they are loaded, otherwise once they load. The promise rejects
   * when their module does not load, and the next call loads it again.
   */
  public checksOf<MethodName extends RegisteredDaemonMethod>(
    method: MethodName,
  ): MethodChecks<MethodName> | Promise<MethodChecks<MethodName>> {
    const loadedChecks = this.#loadedChecks.get(method);
    if (loadedChecks !== undefined) {
      return loadedChecks as unknown as MethodChecks<MethodName>;
    }
    const loadChecks: () => Promise<unknown> = METHOD_CHECK_LOADERS[method];
    return loadChecks().then((loaded) => {
      // A loader is picked by a name known only as a member of the call set, so its checks are
      // typed for that set; the index states each method's own checks.
      const checks = loaded as unknown as MethodChecks<MethodName>;
      this.#loadedChecks.set(method, checks as unknown as MethodChecks<RegisteredDaemonMethod>);
      return checks;
    });
  }
}

/** The checks of every daemon method a window calls. */
export const daemonMethodChecks: DaemonMethodChecks = new DaemonMethodChecks();
