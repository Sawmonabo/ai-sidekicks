// A list call replaced under an unchanged session is a different read. The cases read what each
// commit carried, not what each render saw: with state keyed on the session alone, the render
// under the new call would commit the previous call's definitions before the effect cleared them.
// `tests/helpers/subject-read-commits.tsx` owns the probe.

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

    // Nothing served in the frames after the swap, in particular nothing the first call answered.
    expect(committedDefinitionIds(probe.committed.slice(commitsBeforeSwap))).toStrictEqual([]);
    expect(latestCommitted(probe.committed).state.status).toBe("reading");
  });

  it("reads the replacement call rather than sitting on the reset", async () => {
    // A hook that reset and never re-read would pass the case above and read forever.
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
    // Without this, the cases above pass for a hook that reset on every render and never showed
    // an answer.
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
