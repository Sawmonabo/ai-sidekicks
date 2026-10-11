// The operating system the tests run on, picked once, as the daemon's start picks its own.

import type { DaemonOperatingSystem } from "../../src/operating-system/contract.js";
import { selectDaemonOperatingSystem } from "../../src/operating-system/selection.js";

/** What the system the tests run on supplies the daemon. */
export const HOST_OPERATING_SYSTEM: DaemonOperatingSystem = selectDaemonOperatingSystem(
  process.platform,
  process.env,
);
