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

import { cleanup, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PROBE_SESSION_ID } from "../../workflows-probe.test-support.js";
import {
  RELEASE_CHECKS_BODY,
  authoringBridge,
  mountAuthoring,
  refusalCode,
} from "./definition-authoring-dispatch.test-support.js";

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

    // `file-unreadable` is the reader's own verdict on a file. A chunk that did not
    // arrive read nothing, so claiming the text was unreadable would be this surface
    // reporting a fact it does not have.
    await waitFor(() => {
      expect(refusalCode(mounted.current().outcomes.import)).toBe("call-rejected");
    });
    expect(refusalCode(mounted.current().outcomes.import)).not.toBe("file-unreadable");
  });

  it("negative control: an import that never reaches the codec still answers itself", async () => {
    // The mock removes the codec, and every path that puts the create reads through the
    // codec first. What stays reachable is the refusal an import raises before it reads
    // anything: with no session bound it must still answer `session-unbound`, which
    // shows the hook, the latch and the publish work under the mock. Without it, both
    // cases above would hold over a mock that had broken the whole module registry —
    // every act refusing with `call-rejected` for a reason that had nothing to do with
    // the codec.
    const mounted = mountAuthoring(authoringBridge(), undefined, RELEASE_CHECKS_BODY);
    await mounted.press(() => {
      mounted.current().importDefinition('ai-sidekicks-schema: "1.0"\n');
    });

    expect(refusalCode(mounted.current().outcomes.import)).toBe("session-unbound");
  });
});
