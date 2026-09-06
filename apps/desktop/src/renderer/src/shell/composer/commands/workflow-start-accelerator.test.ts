// What the accelerator starts, what it refuses, and what it never guesses.
//
// The naming rule is asserted on the matcher directly — it is arithmetic over an
// enumeration and driving it through a port would be asserting the rule and the
// transport at once — and the dispatch is asserted through a stub port, because the
// claims there are about which wire is called with what and about a daemon refusal
// reaching the composer unchanged.

import { describe, expect, it, vi } from "vitest";

import { refuse, type ConsoleRefusal } from "../../../console/core/index.js";
import { type GrowthPort, type WorkflowDefinitionSummary } from "../../../console/bridge/index.js";
import {
  WORKFLOW_START_COMMAND_ID,
  matchWorkflowDefinition,
  readWorkflowStartName,
  startWorkflowFromLine,
} from "./workflow-start-accelerator.js";

const SESSION_ID = "d1e2f304-5061-4172-8394-a5b6c7d8e9f0";

function definition(
  name: string,
  overrides: Partial<WorkflowDefinitionSummary> = {},
): WorkflowDefinitionSummary {
  return {
    id: `definition-${name}`,
    name,
    scope: "session",
    scopeRef: SESSION_ID,
    latestVersionNumber: 3,
    latestWorkflowVersionId: `version-${name}`,
    contentHash: "b3:abc",
    resolvesAtThisContext: true,
    createdAt: "2026-09-02T09:00:00.000Z",
    ...overrides,
  };
}

function directiveLine(text: string) {
  return { commandName: WORKFLOW_START_COMMAND_ID, text };
}

/** A refusal the port answers with, in the shape a growth call resolves to. */
function unavailable(code: string): ConsoleRefusal & { readonly status: "unavailable" } {
  return { ...refuse("growth-port", code, "The daemon refused."), status: "unavailable" };
}

/** A port that serves the two operations this module calls and refuses everything else. */
function portServing(options: {
  readonly definitions?: readonly WorkflowDefinitionSummary[];
  readonly listRefusal?: ReturnType<typeof unavailable>;
  readonly startRefusal?: ReturnType<typeof unavailable>;
  readonly onStart?: (request: { readonly workflowVersionId: string }) => void;
}): GrowthPort {
  return {
    workflowDefinitionList: async () =>
      options.listRefusal ?? {
        status: "served",
        value: { definitions: options.definitions ?? [] },
      },
    workflowRunStart: async (request: { readonly workflowVersionId: string }) => {
      options.onStart?.(request);
      return (
        options.startRefusal ?? {
          status: "served",
          value: { workflowRunId: "run-1", state: "running", phaseStates: [] },
        }
      );
    },
  } as unknown as GrowthPort;
}

describe("the name a line names", () => {
  it.each([
    ["a plain name", `/${WORKFLOW_START_COMMAND_ID} nightly-review`, "nightly-review"],
    ["a name with spaces in it", `/${WORKFLOW_START_COMMAND_ID} nightly review`, "nightly review"],
    ["surrounding whitespace", `/${WORKFLOW_START_COMMAND_ID}   nightly  `, "nightly"],
  ])("reads %s", (_case, text, expected) => {
    expect(readWorkflowStartName(directiveLine(text))).toBe(expected);
  });

  it("reads nothing off a line that named only the command", () => {
    expect(readWorkflowStartName(directiveLine(`/${WORKFLOW_START_COMMAND_ID}`))).toBeUndefined();
    expect(
      readWorkflowStartName(directiveLine(`/${WORKFLOW_START_COMMAND_ID}   `)),
    ).toBeUndefined();
  });
});

describe("matching a typed name against the enumeration", () => {
  it("matches one definition exactly", () => {
    const match = matchWorkflowDefinition([definition("nightly"), definition("weekly")], "nightly");

    expect(match.status === "matched" ? match.definition.name : undefined).toBe("nightly");
  });

  it("folds case, because a definition name is a label rather than a wire identifier", () => {
    const match = matchWorkflowDefinition([definition("Nightly Review")], "nightly review");

    expect(match.status).toBe("matched");
  });

  it("never matches on a prefix, because a run is not a search result", () => {
    // The mistake an accelerator must not make: starting `deploy-production` for
    // somebody who typed `deploy`, an act typing more does not undo.
    expect(matchWorkflowDefinition([definition("deploy-production")], "deploy").status).toBe(
      "none",
    );
  });

  it("narrows a name defined at several scopes by the enumeration's own resolution", () => {
    const match = matchWorkflowDefinition(
      [
        definition("review", { id: "shared", resolvesAtThisContext: false, scope: "shared" }),
        definition("review", { id: "session" }),
      ],
      "review",
    );

    expect(match.status === "matched" ? match.definition.id : undefined).toBe("session");
  });

  it("reports ambiguity rather than picking, where the wire resolved none of them", () => {
    const match = matchWorkflowDefinition(
      [
        definition("review", { id: "a", resolvesAtThisContext: false }),
        definition("review", { id: "b", resolvesAtThisContext: false }),
      ],
      "review",
    );

    expect(match).toStrictEqual({ status: "ambiguous", count: 2 });
  });
});

describe("what the accelerator starts", () => {
  it("starts the matched definition's own pinned version", async () => {
    const onStart = vi.fn();
    const outcome = await startWorkflowFromLine(
      directiveLine(`/${WORKFLOW_START_COMMAND_ID} nightly`),
      {
        growth: portServing({ definitions: [definition("nightly")], onStart }),
        sessionId: SESSION_ID,
      },
    );

    expect(outcome).toStrictEqual({ status: "applied" });
    expect(onStart).toHaveBeenCalledWith(
      expect.objectContaining({ workflowVersionId: "version-nightly", sessionId: SESSION_ID }),
    );
  });

  it("carries the daemon's own refusal, `workflow.start_denied` among them", async () => {
    const outcome = await startWorkflowFromLine(
      directiveLine(`/${WORKFLOW_START_COMMAND_ID} nightly`),
      {
        growth: portServing({
          definitions: [definition("nightly")],
          startRefusal: unavailable("workflow.start_denied"),
        }),
        sessionId: SESSION_ID,
      },
    );

    expect(outcome.status === "refused" ? outcome.refusal.code : undefined).toBe(
      "workflow.start_denied",
    );
  });

  it("carries the enumeration's refusal rather than reporting an unknown name", async () => {
    // A read that could not be put says nothing about whether the name exists, and
    // reporting one as the other sends a person looking for a spelling mistake.
    const outcome = await startWorkflowFromLine(
      directiveLine(`/${WORKFLOW_START_COMMAND_ID} nightly`),
      {
        growth: portServing({ listRefusal: unavailable("wire-unregistered") }),
        sessionId: SESSION_ID,
      },
    );

    expect(outcome.status === "refused" ? outcome.refusal.code : undefined).toBe(
      "wire-unregistered",
    );
  });
});

describe("what the accelerator refuses without asking", () => {
  it("refuses a line that named no definition", async () => {
    const onStart = vi.fn();
    const outcome = await startWorkflowFromLine(directiveLine(`/${WORKFLOW_START_COMMAND_ID}`), {
      growth: portServing({ onStart }),
      sessionId: SESSION_ID,
    });

    expect(outcome.status === "refused" ? outcome.refusal.code : undefined).toBe(
      "command-argument-invalid",
    );
    expect(onStart).not.toHaveBeenCalled();
  });

  it("refuses a name the enumeration does not carry", async () => {
    const onStart = vi.fn();
    const outcome = await startWorkflowFromLine(
      directiveLine(`/${WORKFLOW_START_COMMAND_ID} nightly`),
      {
        growth: portServing({ definitions: [definition("weekly")], onStart }),
        sessionId: SESSION_ID,
      },
    );

    expect(outcome.status === "refused" ? outcome.refusal.code : undefined).toBe(
      "command-argument-invalid",
    );
    expect(onStart).not.toHaveBeenCalled();
  });

  it("refuses an ambiguous name rather than starting one of them", async () => {
    const onStart = vi.fn();
    const outcome = await startWorkflowFromLine(
      directiveLine(`/${WORKFLOW_START_COMMAND_ID} review`),
      {
        growth: portServing({
          definitions: [
            definition("review", { id: "a", resolvesAtThisContext: false }),
            definition("review", { id: "b", resolvesAtThisContext: false }),
          ],
          onStart,
        }),
        sessionId: SESSION_ID,
      },
    );

    expect(outcome.status === "refused" ? outcome.refusal.code : undefined).toBe(
      "command-argument-invalid",
    );
    expect(onStart).not.toHaveBeenCalled();
  });

  it("refuses where the composer is addressed within no session", async () => {
    const outcome = await startWorkflowFromLine(
      directiveLine(`/${WORKFLOW_START_COMMAND_ID} nightly`),
      { growth: portServing({ definitions: [definition("nightly")] }), sessionId: undefined },
    );

    expect(outcome.status === "refused" ? outcome.refusal.code : undefined).toBe(
      "command-unavailable-here",
    );
  });
});
