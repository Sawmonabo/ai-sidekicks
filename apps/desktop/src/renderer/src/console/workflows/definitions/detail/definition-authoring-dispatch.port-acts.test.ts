// The two acts that reach the growth port: what settles before a call is put, what the
// create body carries, and what a second press is answered with.
//
// THE PROMOTE CASES ASSERT ON THE REQUEST AND NOT ON THE REPLY, which is the only place
// the copy-on-write marker is observable at all: `parentContentHash` is provenance the
// daemon stores and NEITHER read reply returns, so a promotion that recorded itself as a
// downward fork would be invisible everywhere except in the body this surface sends.
//
// SINGLE FLIGHT IS ASSERTED HERE AND NOT ON THE EXPORT, because the two acts answer a
// second press differently and for a reason. A create is outstanding against the daemon
// and cannot be recalled, so the second press is REFUSED; a clipboard write is neither
// durable nor recallable, so the second press supersedes the first instead — that arm is
// `definition-authoring-dispatch.test.ts` beside this, with the scaffolding both suites
// press through in the `.test-support.ts` beside them.

import { cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { serializeWorkflowDefinitionFile } from "../../../bridge/index.js";
import {
  DEFINITION_RELEASE_CHECKS_SESSION,
  WORKFLOWS_SESSION_ID,
} from "../../../bridge/scenarios/workflow-fixture-ids.js";
import type { GrowthPort, WorkflowDefinitionCreateBody } from "../../../bridge/index.js";
import {
  authoringBridge,
  expectLocalRefusal,
  mountAuthoring,
  scriptedBody,
} from "./definition-authoring-dispatch.test-support.js";

afterEach(cleanup);

/**
 * A create arm that records what was submitted and answers as the daemon would.
 *
 * The REQUEST is the subject of the promote cases, and the refusing port never sees one:
 * its `wire-unregistered` arm answers without being handed a body.
 */
function recordingCreate(
  submitted: WorkflowDefinitionCreateBody[],
): GrowthPort["workflowDefinitionCreate"] {
  return async (request) => {
    submitted.push(request);
    return {
      status: "served",
      value: {
        definitionId: DEFINITION_RELEASE_CHECKS_SESSION,
        versionNumber: 1,
        createdAt: "2026-01-01T07:04:00.000Z",
      },
    };
  };
}

describe("promoting — the promoted bytes, and no copy-on-write marker", () => {
  it("submits no `parentContentHash`, which is the other direction's provenance", async () => {
    // `Spec-017 §Definition scope in the builder (SA-36)`: a promotion creates the
    // shared definition from the promoted version's exact bytes, and the marker belongs
    // to the edit that forks a shared definition DOWNWARD. Setting it here recorded
    // every promoted version as branched from a shared original that never existed.
    const body = scriptedBody();
    const submitted: WorkflowDefinitionCreateBody[] = [];
    const mounted = mountAuthoring(
      authoringBridge({ create: recordingCreate(submitted) }),
      WORKFLOWS_SESSION_ID,
      body,
    );
    await mounted.press(() => {
      mounted.current().promoteDefinition();
    });

    const request = submitted[0];
    expect(request).toBeDefined();
    // ABSENT rather than present-and-undefined: a member the request carries at all is
    // a member the daemon reads.
    expect(Object.keys(request ?? {})).not.toContain("parentContentHash");
    // And the same request is a promotion of THESE bytes, without which the line above
    // would hold over an act that submitted nothing recognisable.
    expect(request?.scope).toBe("shared");
    expect(request?.name).toBe(body.name);
    expect(request?.entry).toEqual(body.entry);
    expect(request?.phaseDefinitions).toEqual(body.phaseDefinitions);
  });

  it("leaves the member on the create shape, for the direction that owns it", () => {
    // Reserved and not deleted. An author editing a `shared` definition submits a
    // NARROWER one carrying the shared original's hash, and that write is the one the
    // member exists for — a claim this case makes at compile time as much as at run.
    const body = scriptedBody();
    const copyOnWrite: WorkflowDefinitionCreateBody = {
      sessionId: WORKFLOWS_SESSION_ID,
      name: body.name,
      scope: "session",
      scopeRef: WORKFLOWS_SESSION_ID,
      parentContentHash: body.contentHash,
      phaseDefinitions: body.phaseDefinitions,
    };

    expect(copyOnWrite.parentContentHash).toBe(body.contentHash);
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
