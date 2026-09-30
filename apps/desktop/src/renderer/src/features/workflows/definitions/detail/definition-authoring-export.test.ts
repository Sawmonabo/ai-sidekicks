// The export act: what it puts on screen, and when it may say the host took it. The bytes come
// from a writer in its own chunk and the host's write is a second call, so the file must outlive
// the host's refusal and the act must not settle before the host answers. Cases wait on the
// condition, not a turn count. A codec that never arrives is
// `hooks/useWorkflowDefinitionAuthoring.codec-unavailable.test.ts`.

import { cleanup, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { PROBE_SESSION_ID } from "../../workflows-probe.test-support.js";
import {
  RELEASE_CHECKS_BODY,
  authoringBridge,
  mountAuthoring,
  outcomeDetail,
  refusalCode,
} from "./hooks/useWorkflowDefinitionAuthoring.test-support.js";

afterEach(cleanup);

/** The marker every exported file opens with, and the whole of what a case reads for. */
const FILE_MARKER = "ai-sidekicks-schema";

describe("exporting — the bytes outlive the host's answer", () => {
  it("settles with the file where the host took it", async () => {
    const mounted = mountAuthoring(authoringBridge(), PROBE_SESSION_ID, RELEASE_CHECKS_BODY);
    await mounted.press(() => {
      mounted.current().exportDefinition();
    });

    // Waited on the settlement, not the bytes: the file is published while the act is still
    // dispatching.
    await waitFor(() => {
      expect(mounted.current().outcomes.export.kind).toBe("settled");
    });
    expect(mounted.current().exportedFile).toContain(FILE_MARKER);
  });

  it("keeps the file on screen when the host refuses the clipboard", async () => {
    // The refusal replaces where the act stands but not what it produced: the bytes are what a
    // person can still act on.
    const mounted = mountAuthoring(
      authoringBridge({
        copyToClipboard: () =>
          Promise.reject({ code: "session.not_found", message: "This session is gone." }),
      }),
      PROBE_SESSION_ID,
      RELEASE_CHECKS_BODY,
    );
    await mounted.press(() => {
      mounted.current().exportDefinition();
    });

    await waitFor(() => {
      expect(refusalCode(mounted.current().outcomes.export)).toBe("session.not_found");
    });
    expect(mounted.current().exportedFile).toContain(FILE_MARKER);
  });
});

describe("exporting — the settlement is the host's answer and not the serialization's", () => {
  it("stays dispatching with the bytes on screen while the host has not answered", async () => {
    // A host that never answers never took the copy, so the outcome must not claim it did.
    const mounted = mountAuthoring(
      authoringBridge({ copyToClipboard: () => new Promise<void>(() => undefined) }),
      PROBE_SESSION_ID,
      RELEASE_CHECKS_BODY,
    );
    await mounted.press(() => {
      mounted.current().exportDefinition();
    });

    await waitFor(() => {
      expect(mounted.current().outcomes.export.kind).toBe("dispatching");
    });
    expect(outcomeDetail(mounted.current().outcomes.export)).not.toContain("on the clipboard");
    // The bytes stay on screen throughout, which makes the pending state usable.
    expect(mounted.current().exportedFile).toContain(FILE_MARKER);
  });

  it("settles only once the host's own write fulfills", async () => {
    // Guards against an export that never settled at all.
    const takers: Array<() => void> = [];
    const mounted = mountAuthoring(
      authoringBridge({
        copyToClipboard: () =>
          new Promise<void>((resolve) => {
            takers.push(resolve);
          }),
      }),
      PROBE_SESSION_ID,
      RELEASE_CHECKS_BODY,
    );
    await mounted.press(() => {
      mounted.current().exportDefinition();
    });
    // The host is reached once the writer's chunk has landed.
    await waitFor(() => {
      expect(takers).toHaveLength(1);
    });
    expect(mounted.current().outcomes.export.kind).toBe("dispatching");

    await mounted.press(() => {
      takers[0]?.();
    });

    const outcome = mounted.current().outcomes.export;
    expect(outcome.kind).toBe("settled");
    expect(outcomeDetail(outcome)).toContain("on the clipboard");
  });

  it("does not let an earlier host answer install over a later press's", async () => {
    // Neither press is refused, so the latch's job here is order: a first press rejecting after
    // a second succeeded must not report a copy that happened as one that did not.
    const answers: Array<{ readonly resolve: () => void; readonly reject: (r: unknown) => void }> =
      [];
    const mounted = mountAuthoring(
      authoringBridge({
        copyToClipboard: () =>
          new Promise<void>((resolve, reject) => {
            answers.push({ resolve, reject });
          }),
      }),
      PROBE_SESSION_ID,
      RELEASE_CHECKS_BODY,
    );
    // Each press reaches the host before the next, so the writes are answered in a known order.
    await mounted.press(() => {
      mounted.current().exportDefinition();
    });
    await waitFor(() => {
      expect(answers).toHaveLength(1);
    });
    await mounted.press(() => {
      mounted.current().exportDefinition();
    });
    await waitFor(() => {
      expect(answers).toHaveLength(2);
    });

    await mounted.press(() => {
      answers[1]?.resolve();
    });
    await mounted.press(() => {
      answers[0]?.reject({ code: "session.not_found", message: "This session is gone." });
    });

    expect(mounted.current().outcomes.export.kind).toBe("settled");
  });
});
