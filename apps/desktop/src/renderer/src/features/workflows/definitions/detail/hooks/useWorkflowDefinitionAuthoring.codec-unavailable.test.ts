// The file acts when the file form's codec chunk does not arrive. It has its own file because
// the mock replaces the module for the whole registry. Both acts run with `void`, so an uncaught
// rejection would leave no refusal on screen; the press must settle as a refusal instead.

import { cleanup, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PROBE_SESSION_ID } from "../../../workflows-probe.test-support.js";
import {
  RELEASE_CHECKS_BODY,
  authoringBridge,
  mountAuthoring,
  refusalCode,
} from "./useWorkflowDefinitionAuthoring.test-support.js";

vi.mock("yaml", () => {
  throw new Error("the definition file form chunk did not load");
});

afterEach(cleanup);

describe("the file acts when the codec did not load", () => {
  it("refuses the export out loud rather than rejecting into nothing", async () => {
    const mounted = mountAuthoring(authoringBridge(), PROBE_SESSION_ID, RELEASE_CHECKS_BODY);
    await mounted.press(() => {
      mounted.current().exportDefinition();
    });

    await waitFor(() => {
      expect(refusalCode(mounted.current().outcomes.export)).toBe("call-rejected");
    });
    expect(mounted.current().exportedFile).toBeUndefined();
  });

  it("refuses the import out loud, and never as a fact about the pasted text", async () => {
    const mounted = mountAuthoring(authoringBridge(), PROBE_SESSION_ID, RELEASE_CHECKS_BODY);
    await mounted.press(() => {
      mounted.current().importDefinition('ai-sidekicks-schema: "1.0"\n');
    });

    // `file-unreadable` is the reader's verdict on a file; a chunk that never arrived read
    // nothing.
    await waitFor(() => {
      expect(refusalCode(mounted.current().outcomes.import)).toBe("call-rejected");
    });
    expect(refusalCode(mounted.current().outcomes.import)).not.toBe("file-unreadable");
  });

  it("negative control: an import that never reaches the codec still answers itself", async () => {
    // Every path that puts the create reads through the mocked codec first. The no-session refusal
    // is raised before any read, so it shows the hook, latch and publish still work under the mock.
    const mounted = mountAuthoring(authoringBridge(), undefined, RELEASE_CHECKS_BODY);
    await mounted.press(() => {
      mounted.current().importDefinition('ai-sidekicks-schema: "1.0"\n');
    });

    expect(refusalCode(mounted.current().outcomes.import)).toBe("session-unbound");
  });
});
