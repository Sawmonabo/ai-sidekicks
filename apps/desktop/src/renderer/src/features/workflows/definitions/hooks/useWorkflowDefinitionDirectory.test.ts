// The enumeration's three states, which the definitions list has to tell apart. The shared
// mount is `useWorkflowDefinitionDirectory.test-support.tsx`; the pages beyond the first are
// `useWorkflowDefinitionDirectory.paging.test.ts`.

import { act, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PROBE_SESSION_ID,
  SECOND_PROBE_SESSION_ID,
  settle,
} from "../../workflows-probe.test-support.js";
import type {
  WorkflowDefinitionDirectory,
  WorkflowDefinitionDirectoryState,
} from "./useWorkflowDefinitionDirectory.js";
import {
  definitionIds,
  lastState,
  observeDirectory,
  rescopableDirectory,
  twoPageCall,
} from "./useWorkflowDefinitionDirectory.test-support.js";

function firstState(
  observed: readonly WorkflowDefinitionDirectory[],
): WorkflowDefinitionDirectoryState {
  const directory = observed[0];
  if (directory === undefined) {
    throw new Error("the probe never rendered, so there is nothing to read");
  }
  return directory.state;
}

describe("useWorkflowDefinitionDirectory — one read, three answers", () => {
  afterEach(() => {
    cleanup();
  });

  it("puts no question at all where no session is in scope", () => {
    // `unasked`, never `reading`: a spinner over an address that names no session would promise
    // an answer that never comes. Asserted on the first render as well as the last.
    const listDefinitions = vi.fn(twoPageCall());
    const observed = observeDirectory(listDefinitions, undefined);
    expect(firstState(observed).status).toBe("unasked");
    expect(lastState(observed).status).toBe("unasked");
    expect(listDefinitions).not.toHaveBeenCalled();
  });

  it("is already reading on the first render a session is in scope for", () => {
    // A state that became `reading` only in an effect would commit one render claiming nobody
    // had asked, drawn as a served-looking empty answer.
    const observed = observeDirectory(async () => ({ definitions: [] }), PROBE_SESSION_ID);
    expect(firstState(observed).status).toBe("reading");
  });

  it("shows the previous session's definitions nowhere once the scope moves", async () => {
    // State keyed on the session alone would keep the first session's rows renderable under the
    // second session until an effect reset them.
    const probe = rescopableDirectory(twoPageCall(), PROBE_SESSION_ID);
    await settle();
    expect(definitionIds(lastState(probe.observed))).toEqual(["first", "second"]);

    act(() => {
      probe.rescope(SECOND_PROBE_SESSION_ID);
    });

    expect(lastState(probe.observed).status).toBe("reading");
  });

  it("starts as a read in flight and settles served, empty included", async () => {
    // An empty page is a real answer, not the absence of one.
    const observed = observeDirectory(async () => ({ definitions: [] }), PROBE_SESSION_ID);
    // Every render before the answer, first included, is `reading`.
    expect(lastState(observed).status).toBe("reading");

    await settle();
    expect(lastState(observed).status).toBe("served");
  });
});
