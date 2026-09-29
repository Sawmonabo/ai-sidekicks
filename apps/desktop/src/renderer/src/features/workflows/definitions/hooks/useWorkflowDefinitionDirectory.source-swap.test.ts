// A list call replaced under an unchanged session is a different read, and the first
// committed render says so: with the state keyed on the session alone, the render under
// the new call would commit the PREVIOUS call's definitions and only the passive effect
// afterwards would take them down.
//
// The cases read what each COMMIT carried rather than what each render call saw, which
// is the only vantage that can tell the two hooks apart —
// `store/subject-read-commits.test-support.tsx` owns that probe and states why.

import { cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  latestCommitted,
  observeSubjectRead,
  type ObservedSubjectRead,
} from "@test/helpers/subject-read-commits.js";
import { PROBE_SESSION_ID, settle } from "../../workflows-probe.test-support.js";
import { definitionWithId } from "./useWorkflowDefinitionDirectory.test-support.js";
import {
  useWorkflowDefinitionDirectory,
  type WorkflowDefinitionDirectory,
  type WorkflowDefinitionListCall,
} from "./useWorkflowDefinitionDirectory.js";

/** A list call that answers one page holding one definition. */
function callServing(definitionId: string): WorkflowDefinitionListCall {
  return async () => ({ definitions: [definitionWithId(definitionId)] });
}

function observeDirectory(
  listDefinitions: WorkflowDefinitionListCall,
): ObservedSubjectRead<WorkflowDefinitionListCall, WorkflowDefinitionDirectory, string> {
  return observeSubjectRead(useWorkflowDefinitionDirectory, {
    source: listDefinitions,
    subject: PROBE_SESSION_ID,
  });
}

function committedDefinitionIds(
  committed: readonly WorkflowDefinitionDirectory[],
): readonly string[] {
  return committed.flatMap((directory) =>
    directory.state.status === "served" ? directory.state.definitions.map((row) => row.id) : [],
  );
}

describe("useWorkflowDefinitionDirectory — the list call is part of the read's subject", () => {
  afterEach(() => {
    cleanup();
  });

  it("commits no definition from the previous call once the call is replaced", async () => {
    const probe = observeDirectory(callServing("first-call"));
    await settle();
    expect(committedDefinitionIds(probe.committed)).toStrictEqual(["first-call"]);
    const commitsBeforeSwap = probe.committed.length;

    probe.readdress({ source: callServing("second-call"), subject: PROBE_SESSION_ID });

    // Nothing served at all in the frames after the swap, and in particular nothing the
    // first call answered.
    expect(committedDefinitionIds(probe.committed.slice(commitsBeforeSwap))).toStrictEqual([]);
    expect(latestCommitted(probe.committed).state.status).toBe("reading");
  });

  it("reads the replacement call rather than sitting on the reset", async () => {
    // The reset is only half the claim: a hook that reset and never re-read would pass
    // the case above and leave the surface reading forever.
    const probe = observeDirectory(callServing("first-call"));
    await settle();

    probe.readdress({ source: callServing("second-call"), subject: PROBE_SESSION_ID });
    await settle();

    const settled = latestCommitted(probe.committed).state;
    expect(settled.status).toBe("served");
    if (settled.status === "served") {
      expect(settled.definitions.map((row) => row.id)).toStrictEqual(["second-call"]);
    }
  });

  it("negative control: a re-render at the SAME call keeps its settled definitions", async () => {
    // Without this, the cases above pass for a hook that reset on every render, which
    // would re-read the enumeration forever and never show an answer at all.
    const listDefinitions = callServing("first-call");
    const probe = observeDirectory(listDefinitions);
    await settle();

    probe.readdress({ source: listDefinitions, subject: PROBE_SESSION_ID });

    const settled = latestCommitted(probe.committed).state;
    expect(settled.status).toBe("served");
    if (settled.status === "served") {
      expect(settled.definitions.map((row) => row.id)).toStrictEqual(["first-call"]);
    }
  });
});
