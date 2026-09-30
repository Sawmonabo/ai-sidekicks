// The import act: what settles before a create is put, and single flight. A second import press
// is refused because the create cannot be recalled; the export supersedes instead, and that arm
// is in `definition-authoring-export.test.ts`.

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

describe("importing — what settles before any call is put", () => {
  it("refuses with `session-unbound` where the pane is bound to no session", async () => {
    const mounted = mountAuthoring(authoringBridge(), undefined, RELEASE_CHECKS_BODY);
    await mounted.press(() => {
      mounted.current().importDefinition("{}");
    });

    expectLocalRefusal(mounted.current().outcomes.import, "session-unbound");
  });

  it("negative control: the same text is read once a session is bound", async () => {
    // Without this, the case above would pass over a hook that refused every import.
    const mounted = mountAuthoring(authoringBridge(), PROBE_SESSION_ID, RELEASE_CHECKS_BODY);
    await mounted.press(() => {
      mounted.current().importDefinition("{}");
    });

    // The reader arrives in its own chunk, so the verdict lands when that fetch settles.
    await waitFor(() => {
      expect(mounted.current().outcomes.import.kind).toBe("refused");
    });
    expectLocalRefusal(mounted.current().outcomes.import, "file-unreadable");
  });
});

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

  it("does not let an export the host never answers refuse an import", async () => {
    // The acts take separate keys; sharing one would answer the first import press with a
    // sentence about a submission never made.
    const hungClipboard = (): Promise<void> => new Promise(() => undefined);
    const mounted = mountAuthoring(
      authoringBridge({ copyToClipboard: hungClipboard }),
      PROBE_SESSION_ID,
      RELEASE_CHECKS_BODY,
      outstandingCreate,
    );
    await mounted.press(() => {
      mounted.current().exportDefinition();
    });
    await waitFor(() => {
      expect(mounted.current().outcomes.export.kind).toBe("dispatching");
    });
    const exported = await serializeWorkflowDefinitionFile(RELEASE_CHECKS_BODY);
    await mounted.press(() => {
      mounted.current().importDefinition(exported);
    });

    await waitFor(() => {
      expect(mounted.current().outcomes.import.kind).toBe("dispatching");
    });
  });
});
