// What each act does to the state a control reads, including the two answers that
// arrive after the press.
//
// THE CASE THIS FILE EXISTS FOR IS THE REFUSED CLIPBOARD. Exporting settles twice: the
// serialization is synchronous and the host's write is not, so the outcome a person
// ends up looking at is the host's answer. Holding the bytes on the settled outcome
// made that answer erase them — a refusal saying the copy did not happen, with nothing
// left on screen to select instead — so the file is its own member and the cases below
// pin both halves.
//
// Every case drives the REAL hook over a real growth port. The port is the refusing one
// with a single arm replaced, which is what a build with no `workflow.*` wire actually
// hands this surface.

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { serializeWorkflowDefinitionFile } from "../../../bridge/index.js";
import { createRefusingGrowthPort } from "../../../bridge/growth-port/growth-port.js";
import {
  workflowDefinitionReadFor,
  workflowVersionBodyFor,
} from "../../../bridge/scenarios/workflow-fixture-bodies.js";
import {
  DEFINITION_RELEASE_CHECKS_SESSION,
  WORKFLOWS_SESSION_ID,
} from "../../../bridge/scenarios/workflow-fixture-ids.js";
import type { ConsoleBridge, GrowthPort, WorkflowVersionBody } from "../../../bridge/index.js";
import { crossMacrotaskBoundary } from "../../../core/macrotask-boundary.test-support.js";
import { useWorkflowDefinitionAuthoring } from "./definition-authoring-dispatch.js";
import {
  WORKFLOW_DETAIL_REFUSAL_CODES,
  type WorkflowDefinitionAuthoring,
  type WorkflowDetailActOutcome,
  type WorkflowDetailRefusalCode,
} from "./definition-authoring.js";

afterEach(cleanup);

/**
 * The body the fixture states for the definition every case here is addressed at.
 *
 * The version number is READ off the definition rather than written down: the fixture
 * answers a body for the latest version alone, so a number restated here would be a
 * second copy of a fact that moves whenever the scenario's table does.
 */
function scriptedBody(): WorkflowVersionBody {
  const definition = workflowDefinitionReadFor(DEFINITION_RELEASE_CHECKS_SESSION);
  const body =
    definition === undefined
      ? undefined
      : workflowVersionBodyFor(definition.id, definition.versionNumber);
  if (body === undefined) {
    throw new Error("the fixture states no body for the definition these cases open");
  }
  return body;
}

interface BridgeParts {
  /** Replaces the port's create arm. Absent leaves the refusing one in place. */
  readonly create?: GrowthPort["workflowDefinitionCreate"];
  /** Replaces the host's clipboard write. Absent accepts every write. */
  readonly copyToClipboard?: (file: string) => Promise<void>;
}

/** A bridge carrying exactly the two seams an act reaches: the port and the clipboard. */
function authoringBridge(parts: BridgeParts = {}): ConsoleBridge {
  const refusing = createRefusingGrowthPort();
  const growth: GrowthPort = {
    ...refusing,
    ...(parts.create === undefined ? {} : { workflowDefinitionCreate: parts.create }),
  };
  const copyToClipboard = parts.copyToClipboard ?? (async () => undefined);
  return {
    growth,
    sidekicks: { native: { copyToClipboard } },
  } as unknown as ConsoleBridge;
}

/**
 * Mount the hook against one definition, and give the caller a way to press it.
 *
 * BOTH SUBJECTS ARE REQUIRED AND NEITHER DEFAULTS, which is a decision this file made
 * the hard way: a default parameter is applied to an argument passed as `undefined`, so
 * the two cases that exist to drive an absent session and an absent body were each
 * getting the present one and passing against the wrong arm.
 */
function mountAuthoring(
  bridge: ConsoleBridge,
  sessionId: string | undefined,
  body: WorkflowVersionBody | undefined,
): { current: () => WorkflowDefinitionAuthoring; press: (pressed: () => void) => Promise<void> } {
  const mounted = renderHook(() =>
    useWorkflowDefinitionAuthoring(bridge, DEFINITION_RELEASE_CHECKS_SESSION, sessionId, body),
  );
  return {
    current: () => mounted.result.current,
    press: async (pressed) => {
      await act(async () => {
        pressed();
        // A boundary and not a counted turn: the clipboard write and the create both
        // settle through the normalizer and a publish, and a chain one link deeper
        // would leave a case asserting about the state from before the answer landed.
        await crossMacrotaskBoundary();
      });
    },
  };
}

/** The code on an outcome that refused, or the kind it took instead. */
function refusalCode(outcome: WorkflowDetailActOutcome): string {
  return outcome.kind === "refused" ? outcome.refusal.code : `not refused: ${outcome.kind}`;
}

/**
 * Assert one act refused with a code this surface DECLARES.
 *
 * Two claims and not one: the specific code, and its membership in the closed tuple.
 * Without the second a refusal raised with a string nobody declared would pass every
 * case that names it, which is the whole failure mode the vocabulary exists to stop.
 */
function expectLocalRefusal(
  outcome: WorkflowDetailActOutcome,
  code: WorkflowDetailRefusalCode,
): void {
  expect(refusalCode(outcome)).toBe(code);
  expect(WORKFLOW_DETAIL_REFUSAL_CODES).toContain(code);
}

describe("exporting — the bytes outlive the host's answer", () => {
  it("refuses with `body-unavailable` where the version read answered with no body", async () => {
    const mounted = mountAuthoring(authoringBridge(), WORKFLOWS_SESSION_ID, undefined);
    await mounted.press(() => {
      mounted.current().exportDefinition();
    });

    expectLocalRefusal(mounted.current().outcomes.export, "body-unavailable");
    expect(mounted.current().exportedFile).toBeUndefined();
  });

  it("settles with the file where the host took it", async () => {
    const mounted = mountAuthoring(authoringBridge(), WORKFLOWS_SESSION_ID, scriptedBody());
    await mounted.press(() => {
      mounted.current().exportDefinition();
    });

    const held = mounted.current().exportedFile;
    expect(mounted.current().outcomes.export.kind).toBe("settled");
    expect(held).toBeDefined();
    expect(held).toContain("schemaVersion");
  });

  it("keeps the file on screen when the host refuses the clipboard", async () => {
    // The regression this pins. The refusal replaces where the act STANDS; it does not
    // withdraw what the act produced, because the bytes are the one thing a person can
    // still act on after a copy that did not happen.
    const mounted = mountAuthoring(
      authoringBridge({
        copyToClipboard: () =>
          Promise.reject({ code: "session.not_found", message: "This session is gone." }),
      }),
      WORKFLOWS_SESSION_ID,
      scriptedBody(),
    );
    await mounted.press(() => {
      mounted.current().exportDefinition();
    });

    const held = mounted.current().exportedFile;
    expect(refusalCode(mounted.current().outcomes.export)).toBe("session.not_found");
    expect(held).toBeDefined();
    expect(held).toContain("schemaVersion");
  });
});

describe("importing — what settles before any call is put", () => {
  it("refuses with `session-unbound` where the pane is bound to no session", async () => {
    const mounted = mountAuthoring(authoringBridge(), undefined, scriptedBody());
    await mounted.press(() => {
      mounted.current().importDefinition("{}");
    });

    expectLocalRefusal(mounted.current().outcomes.import, "session-unbound");
  });

  it("negative control: the same text reaches the port once a session is bound", async () => {
    // Without this, the case above would hold over a hook that refused every import —
    // the right answer for one input, arrived at without reading the session at all.
    const mounted = mountAuthoring(authoringBridge(), WORKFLOWS_SESSION_ID, scriptedBody());
    await mounted.press(() => {
      mounted.current().importDefinition("{}");
    });

    expectLocalRefusal(mounted.current().outcomes.import, "file-unreadable");
  });
});

describe("single flight — one outstanding create per act and definition", () => {
  /** A create that never answers, which is what a press mid-flight is waiting on. */
  const outstandingCreate: GrowthPort["workflowDefinitionCreate"] = () => {
    return new Promise(() => undefined);
  };

  it("refuses the second press of one act rather than putting a second create", async () => {
    const mounted = mountAuthoring(
      authoringBridge({ create: outstandingCreate }),
      WORKFLOWS_SESSION_ID,
      scriptedBody(),
    );
    await mounted.press(() => {
      mounted.current().promoteDefinition();
    });
    expect(mounted.current().outcomes.promote.kind).toBe("dispatching");

    await mounted.press(() => {
      mounted.current().promoteDefinition();
    });

    expectLocalRefusal(mounted.current().outcomes.promote, "act-in-flight");
  });

  it("does not let an outstanding promote refuse an import", async () => {
    // The two acts take separate keys. Sharing one would answer a person's first press
    // of a different control with a sentence about a submission they never made.
    //
    // The pasted text is a REAL file — the exporter's own output — because an
    // unreadable one refuses at the parse and never reaches the latch, which would
    // make this case pass over a hook that shared one key for both acts.
    const mounted = mountAuthoring(
      authoringBridge({ create: outstandingCreate }),
      WORKFLOWS_SESSION_ID,
      scriptedBody(),
    );
    await mounted.press(() => {
      mounted.current().promoteDefinition();
    });
    await mounted.press(() => {
      mounted.current().importDefinition(serializeWorkflowDefinitionFile(scriptedBody()));
    });

    expect(mounted.current().outcomes.import.kind).toBe("dispatching");
  });
});
