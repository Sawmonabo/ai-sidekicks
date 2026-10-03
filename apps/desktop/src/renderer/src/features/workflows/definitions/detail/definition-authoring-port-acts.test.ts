// The import act's single flight: a second import press is refused because the create cannot be
// recalled.

import { cleanup, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { serializeWorkflowDefinitionFile } from "../definition-file/workflow-definition-file-codec.js";
import { PROBE_SESSION_ID } from "../../workflows-probe.test-support.js";
import {
  RELEASE_CHECKS_BODY,
  authoringBridge,
  expectLocalRefusal,
  mountAuthoring,
} from "./hooks/useWorkflowDefinitionAuthoring.test-support.js";
import type { WorkflowDefinitionCreateCall } from "./definition-authoring-runtime.js";

afterEach(cleanup);

describe("single flight — one outstanding create per act and definition", () => {
  const outstandingCreate: WorkflowDefinitionCreateCall = () => {
    return new Promise(() => undefined);
  };

  it("refuses the second press of the import rather than putting a second create", async () => {
    const mounted = mountAuthoring(
      authoringBridge(),
      PROBE_SESSION_ID,
      RELEASE_CHECKS_BODY,
      outstandingCreate,
    );
    // The pasted text is a real file (the exporter's own output), because unreadable text
    // refuses at the parse and never reaches the latch. It is composed before the press since
    // the serializer answers a promise.
    const exported = await serializeWorkflowDefinitionFile(RELEASE_CHECKS_BODY);
    await mounted.press(() => {
      mounted.current().importDefinition(exported);
    });
    await waitFor(() => {
      expect(mounted.current().outcomes.import.kind).toBe("dispatching");
    });

    await mounted.press(() => {
      mounted.current().importDefinition(exported);
    });

    await waitFor(() => {
      expectLocalRefusal(mounted.current().outcomes.import, "act-in-flight");
    });
  });
});
