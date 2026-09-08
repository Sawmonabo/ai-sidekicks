// What the two file acts do when the file form's codec does not arrive.
//
// ITS OWN FILE BECAUSE THE MOCK IS THE WHOLE POINT. The reader and the writer are
// fetched on first use — the parser is charged to the launches that use it and to no
// others — so the one way they fail is a fetch that did not land, and reproducing that
// means replacing the module for the whole registry. A suite that did it beside the
// ordinary cases would take the codec away from those too; a file of its own gets its
// own registry, and every other case still runs against the real one.
//
// THE CLASS THIS GUARDS. Both acts are dispatched with `void`, so a rejection that
// nothing caught would be an unhandled rejection: no refusal on screen, no sentence,
// and a control that answers a press with nothing at all. What is asserted here is that
// the press settles as a refusal instead.

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createRefusingGrowthPort } from "../../../bridge/growth-port/growth-port.js";
import { crossMacrotaskBoundary } from "../../../core/macrotask-boundary.test-support.js";
import { useWorkflowDefinitionAuthoring } from "./definition-authoring-dispatch.js";
import type { ConsoleBridge, WorkflowVersionBody } from "../../../bridge/index.js";
import type { WorkflowDetailActOutcome } from "./definition-authoring.js";

vi.mock("yaml", () => {
  throw new Error("the definition file form chunk did not load");
});

afterEach(cleanup);

const SESSION_ID = "019b7a12-0280-75e5-8510-ada11a5a3401";
const DEFINITION_ID = "019b7a10-0280-7c11-8100-def111150001";

/** The body the acts are addressed at; its content never reaches a codec here. */
const BODY: WorkflowVersionBody = {
  definitionId: DEFINITION_ID,
  versionNumber: 4,
  workflowVersionId: "019b7a10-0280-7d22-8100-be5100150004",
  contentHash: "b3:0f3c9a1d7e5b42c8a06d1f93be27540ac1d8e6b3927fa04c5de81b6203794acd",
  schemaVersion: "1.0",
  name: "Release checks",
  entry: { startMode: "manual" },
  phaseDefinitions: [
    {
      phaseId: "phase-draft",
      name: "Draft",
      type: "single-agent",
      gateType: "auto-continue",
      failureBehavior: "retry",
    },
  ],
  createdAt: "2026-01-01T07:04:00.000Z",
};

/** A bridge carrying the two seams an act reaches, neither of which is exercised. */
function authoringBridge(): ConsoleBridge {
  return {
    growth: createRefusingGrowthPort(),
    sidekicks: { native: { copyToClipboard: async () => undefined } },
  } as unknown as ConsoleBridge;
}

/** The hook mounted at one definition, with a way to press it and let it settle. */
function mountAuthoring(): {
  current: () => ReturnType<typeof useWorkflowDefinitionAuthoring>;
  press: (pressed: () => void) => Promise<void>;
} {
  const bridge = authoringBridge();
  const mounted = renderHook(() =>
    useWorkflowDefinitionAuthoring(bridge, DEFINITION_ID, SESSION_ID, BODY),
  );
  return {
    current: () => mounted.result.current,
    press: async (pressed) => {
      await act(async () => {
        pressed();
        await crossMacrotaskBoundary();
      });
    },
  };
}

/** The code an outcome refused with, or the kind it took instead. */
function refusalCode(outcome: WorkflowDetailActOutcome): string {
  return outcome.kind === "refused" ? outcome.refusal.code : `not refused: ${outcome.kind}`;
}

describe("the file acts when the codec did not load", () => {
  it("refuses the export out loud rather than rejecting into nothing", async () => {
    const mounted = mountAuthoring();
    await mounted.press(() => {
      mounted.current().exportDefinition();
    });

    await waitFor(() => {
      expect(refusalCode(mounted.current().outcomes.export)).toBe("call-rejected");
    });
    expect(mounted.current().exportedFile).toBeUndefined();
  });

  it("refuses the import out loud, and never as a fact about the pasted text", async () => {
    const mounted = mountAuthoring();
    await mounted.press(() => {
      mounted.current().importDefinition('ai-sidekicks-schema: "1.0"\n');
    });

    // `file-unreadable` is the reader's own verdict on a file. A chunk that did not
    // arrive read nothing, so claiming the text was unreadable would be this surface
    // reporting a fact it does not have.
    await waitFor(() => {
      expect(refusalCode(mounted.current().outcomes.import)).toBe("call-rejected");
    });
    expect(refusalCode(mounted.current().outcomes.import)).not.toBe("file-unreadable");
  });

  it("negative control: the promote act still reaches the port, so the mock broke nothing else", async () => {
    // Promoting reaches no codec at all, and the refusing port answers it with the code
    // it answers every unserved growth call with. Without this, both cases above would
    // hold over a mock that had broken the whole module registry — every act refusing,
    // for a reason that had nothing to do with the codec.
    const mounted = mountAuthoring();
    await mounted.press(() => {
      mounted.current().promoteDefinition();
    });

    await waitFor(() => {
      expect(refusalCode(mounted.current().outcomes.promote)).toBe("wire-unregistered");
    });
  });
});
