// The pages beyond the first: the daemon's cursor is kept and the next page appends in order.

import { act, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { crossMacrotaskBoundary } from "@test/helpers/macrotask-boundary.js";
import { PROBE_SESSION_ID } from "../../workflows-probe.test-support.js";
import { settle } from "@test/helpers/settle.js";
import type { WorkflowDefinitionDirectory } from "./useWorkflowDefinitionDirectory.js";
import {
  definitionIds,
  latest,
  lastState,
  observeDirectory,
  twoPageCall,
} from "./useWorkflowDefinitionDirectory.test-support.js";

/** Press the continuation the definitions list would offer, and let its page settle. */
async function continueReading(observed: readonly WorkflowDefinitionDirectory[]): Promise<void> {
  await act(async () => {
    latest(observed).continueReading();
    await crossMacrotaskBoundary();
  });
}

describe("useWorkflowDefinitionDirectory — the pages beyond the first", () => {
  afterEach(() => {
    cleanup();
  });

  it("keeps the daemon's cursor and appends the page it reaches, in order", async () => {
    // A hook that discarded `nextCursor` would stop at two rows with nothing saying there were
    // more.
    const observed = observeDirectory(twoPageCall(), PROBE_SESSION_ID);
    await settle();
    expect(definitionIds(lastState(observed))).toStrictEqual(["first", "second"]);

    await continueReading(observed);

    expect(definitionIds(lastState(observed))).toStrictEqual([
      "first",
      "second",
      "third",
      "fourth",
    ]);
  });
});
