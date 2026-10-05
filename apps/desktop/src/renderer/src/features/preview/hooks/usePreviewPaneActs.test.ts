// The acts settle out of dispatch order: awaiting each act first would exercise a sequence that
// cannot go wrong. An older failure must not displace a newer success, and an older success must
// not clear a newer failure.

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { type PlatformBridge } from "#renderer/services/platform/platform-bridge.js";
import { refuse, type Refusal } from "#renderer/lib/refusal/refusal.js";
import { settle as settleReactWork } from "#test/helpers/settle.js";
import { fixturePreviewBridge } from "../PreviewPane.test-support.js";
import { usePreviewPaneActs } from "./usePreviewPaneActs.js";

/** The fallback a rejection with no code of its own is rendered as. */
const FALLBACK = {
  code: "open-external-failed",
  detail: "The system browser could not be reached from this window.",
} as const;

/** One act the test settles by hand, in whichever order the case needs. */
function deferredAct(): {
  readonly run: () => Promise<Refusal | undefined>;
  readonly serve: () => void;
  readonly refuseWith: (refusal: Refusal) => void;
  readonly reject: (failure: unknown) => void;
} {
  let settle:
    | {
        readonly resolve: (value: Refusal | undefined) => void;
        readonly reject: (failure: unknown) => void;
      }
    | undefined;
  return {
    run: async () =>
      new Promise<Refusal | undefined>((resolve, reject) => {
        settle = { resolve, reject };
      }),
    serve: () => {
      settle?.resolve(undefined);
    },
    refuseWith: (refusal) => {
      settle?.resolve(refusal);
    },
    reject: (failure: unknown) => {
      settle?.reject(failure);
    },
  };
}

const PORT_REFUSAL = refuse("preview-pane", "open-external-failed", "The page did not open.");

/** The subject an act belongs to: which bridge it went out on, and for which pane. */
interface ActSubject {
  readonly bridge: PlatformBridge;
  readonly paneId: string;
}

function subject(paneId: string, bridge?: PlatformBridge): ActSubject {
  return {
    bridge: bridge ?? fixturePreviewBridge().bridge,
    paneId,
  };
}

const FIRST_SUBJECT = subject("pane-browser-1");

describe("the Preview pane's act sequence", () => {
  it("drops an older act's failure once a newer act has been served", async () => {
    const reload = deferredAct();
    const stop = deferredAct();
    const { result } = renderHook(() =>
      usePreviewPaneActs(FIRST_SUBJECT.bridge, FIRST_SUBJECT.paneId),
    );

    act(() => {
      result.current.run(reload.run, FALLBACK);
      result.current.run(stop.run, FALLBACK);
    });
    stop.serve();
    await settleReactWork();
    reload.reject(new Error("the reload never answered"));
    await settleReactWork();

    expect(result.current.refusal).toBeUndefined();
  });

  it("drops an older act's success rather than letting it clear a newer refusal", async () => {
    // A completion that clears is as much a write as one that refuses.
    const first = deferredAct();
    const second = deferredAct();
    const { result } = renderHook(() =>
      usePreviewPaneActs(FIRST_SUBJECT.bridge, FIRST_SUBJECT.paneId),
    );

    act(() => {
      result.current.run(first.run, FALLBACK);
      result.current.run(second.run, FALLBACK);
    });
    second.refuseWith(PORT_REFUSAL);
    await settleReactWork();
    first.serve();
    await settleReactWork();

    expect(result.current.refusal?.code).toBe("open-external-failed");
  });

  it("renders the newest act's own rejection", async () => {
    // A sequence that wrote nothing would pass the two dropping cases above.
    const only = deferredAct();
    const { result } = renderHook(() =>
      usePreviewPaneActs(FIRST_SUBJECT.bridge, FIRST_SUBJECT.paneId),
    );

    act(() => {
      result.current.run(only.run, FALLBACK);
    });
    only.reject({ code: "permission_denied", message: "You may not navigate this pane." });
    await settleReactWork();

    expect(result.current.refusal?.code).toBe("permission_denied");
    expect(result.current.refusal?.detail).toBe("You may not navigate this pane.");
  });
});
