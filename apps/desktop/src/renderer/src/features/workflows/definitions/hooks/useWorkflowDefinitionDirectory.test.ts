// The enumeration has three states, and a surface has to be able to tell them apart.
//
// The mount both suites share — the probe, the readings taken off it, and the call that
// answers per cursor — is `definition-directory.test-support.tsx`. The pages beyond the
// first are the other suite, `definition-directory.paging`.

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
    // `unasked` and never `reading`: a spinner over an address that names no session
    // would promise an answer that is never coming. Asserted on the FIRST render as
    // well as the last, so the arm that must stay `unasked` is held to the same
    // moment as the arm below that must not be.
    const listDefinitions = vi.fn(twoPageCall());
    const observed = observeDirectory(listDefinitions, undefined);
    expect(firstState(observed).status).toBe("unasked");
    expect(lastState(observed).status).toBe("unasked");
    expect(listDefinitions).not.toHaveBeenCalled();
  });

  it("is already reading on the first render a session is in scope for", () => {
    // A state that only became `reading` in an effect, which runs after the commit,
    // would commit one render claiming nobody had asked — and a list draws that as a
    // served-looking empty answer before the request has answered.
    const observed = observeDirectory(async () => ({ definitions: [] }), PROBE_SESSION_ID);
    expect(firstState(observed).status).toBe("reading");
  });

  it("shows the previous session's definitions nowhere once the scope moves", async () => {
    // A state keyed on the session alone would keep the first session's rows renderable
    // under the second session's name until an effect reset them, with nothing on screen
    // saying which session they had been read for.
    const probe = rescopableDirectory(twoPageCall(), PROBE_SESSION_ID);
    await settle();
    expect(definitionIds(lastState(probe.observed))).toEqual(["first", "second"]);

    act(() => {
      probe.rescope(SECOND_PROBE_SESSION_ID);
    });

    expect(lastState(probe.observed).status).toBe("reading");
  });

  it("starts as a read in flight and settles served, empty included", async () => {
    // An empty page is a real answer about this context, not the absence of one.
    const observed = observeDirectory(async () => ({ definitions: [] }), PROBE_SESSION_ID);
    // The state after the mount and before the answer. Every render of it, first
    // included, because the read is held against the session it is about.
    expect(lastState(observed).status).toBe("reading");

    await settle();
    expect(lastState(observed).status).toBe("served");
  });
});
