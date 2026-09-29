// The import, the act that puts the create call: what settles before a call is put, and
// what a second press is answered with.
//
// SINGLE FLIGHT IS ASSERTED HERE AND NOT ON THE EXPORT, because the two acts answer a
// second press differently and for a reason. A create is outstanding against the daemon
// and cannot be recalled, so the second press is REFUSED; a clipboard write is neither
// durable nor recallable, so the second press supersedes the first instead — that arm is
// `definition-authoring-export.test.ts` beside this, with the scaffolding both suites
// press through in the `.test-support.ts` beside them.

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
    // Without this, the case above would hold over a hook that refused every import —
    // the right answer for one input, arrived at without reading the session at all.
    const mounted = mountAuthoring(authoringBridge(), PROBE_SESSION_ID, RELEASE_CHECKS_BODY);
    await mounted.press(() => {
      mounted.current().importDefinition("{}");
    });

    // Waited on rather than slept on: the reader arrives in its own chunk, so the
    // verdict on this text lands when that fetch settles.
    await waitFor(() => {
      expect(mounted.current().outcomes.import.kind).toBe("refused");
    });
    expectLocalRefusal(mounted.current().outcomes.import, "file-unreadable");
  });
});

describe("single flight — one outstanding create per act and definition", () => {
  /** A create that never answers, which is what a press mid-flight is waiting on. */
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
    // The pasted text is a REAL file — the exporter's own output — because an unreadable
    // one refuses at the parse and never reaches the latch. Composed BEFORE the press
    // rather than inside it: the writer arrives in its own chunk, so the serializer
    // answers a promise and a press handed one would import the promise's own text.
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
    // The two acts take separate keys. Sharing one would answer a person's first press of
    // the import with a sentence about a submission they never made, for as long as the
    // host takes to answer the export's clipboard write.
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
    // The export holds its key while the host is asked, which is the state under test.
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
