// The export act: what it puts on screen, and when it may say the host took it.
//
// EXPORTING SETTLES TWICE, which is the asymmetry every case here is about. The bytes
// are composed by a writer that arrives in its own chunk, the host's write is a second
// call after it, and the answer a person ends up looking at is the host's. Three things
// went wrong across that seam and all of them are pinned below.
//
// THE BYTES MUST OUTLIVE THE ANSWER. Holding the file on the settled outcome let the
// host's refusal erase it — a sentence saying the copy did not happen, with nothing left
// on screen to select instead — so the file is its own member.
//
// AND THE ACT MAY NOT CLAIM TO HAVE SETTLED BEFORE THE HOST ANSWERS. The outcome was
// published as settled beside the serialization, so a host that hung left "is on the
// clipboard" on screen over a copy that never happened, forever for a call that never
// answers. The cases drive a never-answering clipboard, a deferred one, and two presses
// whose answers arrive out of order.
//
// AND NOTHING IS SLEPT ON. Every case here waits for the CONDITION it is about, because
// the writer's chunk lands when its fetch settles and not a fixed number of turns after
// a press. A codec that never arrived at all is `definition-authoring-dispatch.codec-absence.test.ts`,
// which needs a registry of its own to reproduce.
//
// The two acts that reach the growth port are `definition-authoring-port-acts.test.ts`,
// and the scaffolding both suites press through is the `.test-support.ts` beside them.

import { cleanup, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { WORKFLOWS_SESSION_ID } from "../../../bridge/scenario/workflows/ids.js";
import {
  authoringBridge,
  expectLocalRefusal,
  mountAuthoring,
  outcomeDetail,
  refusalCode,
  scriptedBody,
} from "./definition-authoring-dispatch.test-support.js";

afterEach(cleanup);

/** The marker every exported file opens with, and the whole of what a case reads for. */
const FILE_MARKER = "ai-sidekicks-schema";

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

    // WAITED ON THE SETTLEMENT AND NOT ON THE BYTES: the file is published while the
    // act is still dispatching, so a wait on the file alone would read the outcome one
    // step before the host had answered.
    await waitFor(() => {
      expect(mounted.current().outcomes.export.kind).toBe("settled");
    });
    expect(mounted.current().exportedFile).toContain(FILE_MARKER);
  });

  it("keeps the file on screen when the host refuses the clipboard", async () => {
    // The refusal replaces where the act STANDS; it does not withdraw what the act
    // produced, because the bytes are the one thing a person can still act on after a
    // copy that did not happen.
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

    await waitFor(() => {
      expect(refusalCode(mounted.current().outcomes.export)).toBe("session.not_found");
    });
    expect(mounted.current().exportedFile).toContain(FILE_MARKER);
  });
});

describe("exporting — the settlement is the host's answer and not the serialization's", () => {
  it("stays dispatching with the bytes on screen while the host has not answered", async () => {
    // The regression this pins. A host that never answers never took the copy, and an
    // outcome published beside the serialization asserted that it had — for the life of
    // the pane, with no later answer to correct it.
    const mounted = mountAuthoring(
      authoringBridge({ copyToClipboard: () => new Promise<void>(() => undefined) }),
      WORKFLOWS_SESSION_ID,
      scriptedBody(),
    );
    await mounted.press(() => {
      mounted.current().exportDefinition();
    });

    await waitFor(() => {
      expect(mounted.current().outcomes.export.kind).toBe("dispatching");
    });
    expect(outcomeDetail(mounted.current().outcomes.export)).not.toContain("on the clipboard");
    // The bytes are on screen throughout, which is what makes the pending state usable
    // rather than merely honest.
    expect(mounted.current().exportedFile).toContain(FILE_MARKER);
  });

  it("settles only once the host's own write fulfils", async () => {
    // The negative control for the case above: without it, that one would hold over an
    // export that never settled at all.
    const takers: Array<() => void> = [];
    const mounted = mountAuthoring(
      authoringBridge({
        copyToClipboard: () =>
          new Promise<void>((resolve) => {
            takers.push(resolve);
          }),
      }),
      WORKFLOWS_SESSION_ID,
      scriptedBody(),
    );
    await mounted.press(() => {
      mounted.current().exportDefinition();
    });
    // The host is reached once the writer's chunk has landed, so what the case waits on
    // is the call arriving rather than a count of turns since the press.
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
    // Two presses write the same bytes and neither is refused, so what the latch is for
    // on this act is ORDER: a first press rejecting after a second succeeded would
    // report a copy that DID happen as one that did not.
    const answers: Array<{ readonly resolve: () => void; readonly reject: (r: unknown) => void }> =
      [];
    const mounted = mountAuthoring(
      authoringBridge({
        copyToClipboard: () =>
          new Promise<void>((resolve, reject) => {
            answers.push({ resolve, reject });
          }),
      }),
      WORKFLOWS_SESSION_ID,
      scriptedBody(),
    );
    // Each press is let reach the host before the next is made, so the two outstanding
    // writes are in the order the cases below answer them in rather than in whichever
    // order two chunk fetches happened to settle.
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
