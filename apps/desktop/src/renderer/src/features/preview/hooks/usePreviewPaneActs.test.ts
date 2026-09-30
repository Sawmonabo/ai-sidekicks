// Every case settles its acts out of dispatch order: awaiting each act first would exercise a
// sequence that cannot go wrong. An older failure must not displace a newer success, and an
// older success must not clear a newer failure.

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { unscriptedScenario } from "@test/helpers/fixture-bridge.js";
import { createFixtureBridge } from "@renderer/services/platform/platform-bridge.fixture.js";
import { type PlatformBridge } from "@renderer/services/platform/platform-bridge.js";
import { refuse, type Refusal } from "@renderer/lib/refusal.js";
import { settle as settleReactWork } from "@test/helpers/settle.js";
import { usePreviewPaneActs, type PreviewPaneActs } from "./usePreviewPaneActs.js";

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
    bridge:
      bridge ?? createFixtureBridge({ scenario: unscriptedScenario("browser-pane-test") }).bridge,
    paneId,
  };
}

/**
 * The hook under one subject, with the re-render that hands it another. A pane layout
 * rebinding a slot keeps the hook instance and changes its inputs, which a fresh mount never
 * reaches.
 */
function renderActs(initial: ActSubject): {
  readonly acts: () => PreviewPaneActs;
  readonly rebindTo: (next: ActSubject) => void;
} {
  const { result, rerender } = renderHook(
    (props: ActSubject) => usePreviewPaneActs(props.bridge, props.paneId),
    { initialProps: initial },
  );
  return {
    acts: () => result.current,
    rebindTo: (next) => {
      act(() => {
        rerender(next);
      });
    },
  };
}

const FIRST_SUBJECT = subject("pane-browser-1");
const SECOND_SUBJECT = subject("pane-browser-2", FIRST_SUBJECT.bridge);

describe("the browser pane's act sequence", () => {
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

  it("lets a local refusal outrank an act dispatched before it", async () => {
    // The address guard and the close-tab chord settle without crossing the boundary.
    const pending = deferredAct();
    const { result } = renderHook(() =>
      usePreviewPaneActs(FIRST_SUBJECT.bridge, FIRST_SUBJECT.paneId),
    );

    act(() => {
      result.current.run(pending.run, FALLBACK);
    });
    act(() => {
      result.current.refuseLocally("file-address", "Web destinations only.");
    });
    pending.serve();
    await settleReactWork();

    expect(result.current.refusal?.code).toBe("file-address");
  });

  it("keeps reporting the act that was already in flight when a banner was dismissed", async () => {
    // Dismissal means "I have read this", not "I started something newer"; the running act's
    // failure is still news.
    const pending = deferredAct();
    const { result } = renderHook(() =>
      usePreviewPaneActs(FIRST_SUBJECT.bridge, FIRST_SUBJECT.paneId),
    );

    act(() => {
      result.current.run(pending.run, FALLBACK);
    });
    act(() => {
      result.current.dismiss();
    });
    pending.reject(new Error("the call never answered"));
    await settleReactWork();

    expect(result.current.refusal?.code).toBe("open-external-failed");
  });

  it("negative control: the newest act's own rejection is rendered", async () => {
    // Without this, a sequence that wrote nothing would pass the two dropping cases above.
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

describe("the act state belongs to the pane the acts were dispatched for", () => {
  it("drops a settlement that lands after the pane was rebound", async () => {
    const pending = deferredAct();
    const { acts, rebindTo } = renderActs(FIRST_SUBJECT);

    act(() => {
      acts().run(pending.run, FALLBACK);
    });
    rebindTo(SECOND_SUBJECT);
    pending.refuseWith(PORT_REFUSAL);
    await settleReactWork();

    expect(acts().refusal).toBeUndefined();
  });

  it("drops a settlement that lands after the bridge was replaced", async () => {
    // A call made on a replaced bridge cannot report about the page the window holds now,
    // whatever the pane is called.
    const pending = deferredAct();
    const { acts, rebindTo } = renderActs(FIRST_SUBJECT);

    act(() => {
      acts().run(pending.run, FALLBACK);
    });
    rebindTo(subject(FIRST_SUBJECT.paneId));
    pending.reject(new Error("the call never answered"));
    await settleReactWork();

    expect(acts().refusal).toBeUndefined();
  });

  it("clears a refusal already on screen when the pane is rebound", async () => {
    // The local arm never crosses the boundary, so a token alone cannot drop it.
    const { acts, rebindTo } = renderActs(FIRST_SUBJECT);

    act(() => {
      acts().refuseLocally("file-address", "Web destinations only.");
    });
    expect(acts().refusal?.code).toBe("file-address");

    rebindTo(SECOND_SUBJECT);

    expect(acts().refusal).toBeUndefined();
  });

  it("still reports the replacement pane's own act", async () => {
    // The rebind retires the previous subject's acts, not the hook.
    const { acts, rebindTo } = renderActs(FIRST_SUBJECT);
    rebindTo(SECOND_SUBJECT);
    const afterRebind = deferredAct();

    act(() => {
      acts().run(afterRebind.run, FALLBACK);
    });
    afterRebind.refuseWith(PORT_REFUSAL);
    await settleReactWork();

    expect(acts().refusal?.code).toBe("open-external-failed");
  });

  it("negative control: a re-render that keeps the subject keeps the refusal", async () => {
    // Without it the cases above would pass against a hook that cleared its refusal on any
    // re-render, and a pane re-renders on every reported navigation. The refusal is the
    // close-tab chord's, which reaches this hook without crossing the boundary.
    const { acts, rebindTo } = renderActs(FIRST_SUBJECT);

    act(() => {
      acts().refuseLocally("no-selected-page", "There is no selected page to close.");
    });
    rebindTo({ ...FIRST_SUBJECT });

    expect(acts().refusal?.code).toBe("no-selected-page");
  });
});
