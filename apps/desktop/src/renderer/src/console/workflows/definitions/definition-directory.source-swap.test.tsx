// A bridge replaced under an unchanged session is a different read, and the first
// committed render says so.
//
// The fixture's scenario switch mints a new bridge and hands back the same session id,
// which is the reachable path here: with the stamp keyed on the session alone the state
// agreed with itself, so the render under the new port committed the PREVIOUS
// scenario's definitions and only the passive effect afterwards took them down.
//
// The cases read what each COMMIT carried rather than what each render call saw, which
// is the only vantage that can tell the two hooks apart —
// `store/subject-read-commits.test-support.tsx` owns that probe and states why.

import { act, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { GrowthPort } from "../../bridge/index.js";
import { createRefusingGrowthPort } from "../../bridge/growth-port.js";
import {
  latestCommitted,
  observeSubjectRead,
  type ObservedSubjectRead,
} from "../../store/subject-read-commits.test-support.js";
import type { WorkflowDefinitionRow } from "./DefinitionsBrowser.js";
import {
  useWorkflowDefinitionDirectory,
  type WorkflowDefinitionDirectory,
} from "./definition-directory.js";

const PROBE_SESSION_ID = "019b7a12-0280-75e5-8510-ada11a5a3401";

function definition(id: string): WorkflowDefinitionRow {
  return {
    id,
    name: `Definition ${id}`,
    scope: "session",
    scopeRef: PROBE_SESSION_ID,
    latestVersionNumber: 1,
    latestWorkflowVersionId: `${id}-version-1`,
    contentHash: `b3:${id}`,
    resolvesAtThisContext: false,
    createdAt: "2026-01-01T10:00:00.000Z",
  };
}

/** The real port serving one scenario's worth of definitions, and nothing else changed. */
function portServing(definitionId: string): GrowthPort {
  return {
    ...createRefusingGrowthPort(),
    workflowDefinitionList: async () => ({
      status: "served",
      value: { definitions: [definition(definitionId)] },
    }),
  };
}

function observeDirectory(
  growth: GrowthPort,
): ObservedSubjectRead<GrowthPort, WorkflowDefinitionDirectory> {
  return observeSubjectRead(useWorkflowDefinitionDirectory, {
    source: growth,
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

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

describe("useWorkflowDefinitionDirectory — the port is half of what the read is about", () => {
  afterEach(() => {
    cleanup();
  });

  it("commits no definition from the previous bridge once the port is replaced", async () => {
    const probe = observeDirectory(portServing("first-scenario"));
    await settle();
    expect(committedDefinitionIds(probe.committed)).toStrictEqual(["first-scenario"]);
    const commitsBeforeSwap = probe.committed.length;

    probe.readdress({ source: portServing("second-scenario"), subject: PROBE_SESSION_ID });

    // Nothing served at all in the frames after the swap, and in particular nothing the
    // first bridge answered. Before the port joined the stamp, this render committed
    // `first-scenario` under a bridge that had never heard of it.
    expect(committedDefinitionIds(probe.committed.slice(commitsBeforeSwap))).toStrictEqual([]);
    expect(latestCommitted(probe.committed).state.status).toBe("reading");
  });

  it("reads the replacement bridge rather than sitting on the reset", async () => {
    // The reset is only half the claim: a hook that reset and never re-read would pass
    // the case above and leave the surface reading forever.
    const probe = observeDirectory(portServing("first-scenario"));
    await settle();

    probe.readdress({ source: portServing("second-scenario"), subject: PROBE_SESSION_ID });
    await settle();

    const settled = latestCommitted(probe.committed).state;
    expect(settled.status).toBe("served");
    if (settled.status === "served") {
      expect(settled.definitions.map((row) => row.id)).toStrictEqual(["second-scenario"]);
    }
  });

  it("negative control: a re-render at the SAME port keeps the definitions it settled on", async () => {
    // Without this, the cases above pass for a hook that reset on every render, which
    // would re-read the enumeration forever and never show an answer at all.
    const growth = portServing("first-scenario");
    const probe = observeDirectory(growth);
    await settle();

    probe.readdress({ source: growth, subject: PROBE_SESSION_ID });

    const settled = latestCommitted(probe.committed).state;
    expect(settled.status).toBe("served");
    if (settled.status === "served") {
      expect(settled.definitions.map((row) => row.id)).toStrictEqual(["first-scenario"]);
    }
  });
});
