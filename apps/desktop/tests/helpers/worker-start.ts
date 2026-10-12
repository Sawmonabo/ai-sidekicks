// The workers a browser-tier test starts, ended when the test finishes, so none outlives its test
// in the page the next test runs in.

import { onTestFinished } from "vitest";

import type { WorkerStart } from "#renderer/lib/worker-port.js";

/** `start`, with every worker it starts ended when the running test finishes. */
export function endWorkersWithTest<Request, Reply>(
  start: WorkerStart<Request, Reply>,
): WorkerStart<Request, Reply> {
  return () => {
    const port = start();
    onTestFinished(() => {
      port.terminate();
    });
    return port;
  };
}
