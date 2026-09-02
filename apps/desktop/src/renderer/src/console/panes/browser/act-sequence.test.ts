// Which answer the pane is allowed to render, when two acts are in flight.
//
// Every case here is an ordering, so each one settles its acts DELIBERATELY out of
// the order they were dispatched in — a suite that awaited each act before starting
// the next would exercise a sequence that cannot go wrong and would pass against the
// defect. The pair that matters is symmetric: an older failure must not displace a
// newer success, and an older success must not clear a newer failure.

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { refuse, type ConsoleRefusal } from "../../core/index.js";
import { useBrowserPaneActs } from "./act-sequence.js";

/** The fallback a rejection with no code of its own is rendered as. */
const FALLBACK = {
  code: "navigation-call-failed",
  detail: "The call into the browser never answered.",
} as const;

/** One act the test settles by hand, in whichever order the case needs. */
function deferredAct(): {
  readonly run: () => Promise<ConsoleRefusal | undefined>;
  readonly serve: () => void;
  readonly refuseWith: (refusal: ConsoleRefusal) => void;
  readonly reject: (failure: unknown) => void;
} {
  let settle:
    | {
        readonly resolve: (value: ConsoleRefusal | undefined) => void;
        readonly reject: (failure: unknown) => void;
      }
    | undefined;
  return {
    run: async () =>
      new Promise<ConsoleRefusal | undefined>((resolve, reject) => {
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

/** Let a settled promise reach the hook's state, inside React's own scope. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

const PORT_REFUSAL = refuse("browser-pane", "wire-unregistered", "No verb is registered.");

describe("the browser pane's act sequence", () => {
  it("drops an older act's failure once a newer act has been served", async () => {
    const reload = deferredAct();
    const stop = deferredAct();
    const { result } = renderHook(() => useBrowserPaneActs());

    act(() => {
      result.current.run(reload.run, FALLBACK);
      result.current.run(stop.run, FALLBACK);
    });
    stop.serve();
    await settle();
    reload.reject(new Error("the reload never answered"));
    await settle();

    expect(result.current.refusal).toBeUndefined();
  });

  it("drops an older act's success rather than letting it clear a newer refusal", async () => {
    // The same defect with the outcomes swapped, and the reason the guard covers the
    // whole write: a completion that clears is as much a write as one that refuses.
    const first = deferredAct();
    const second = deferredAct();
    const { result } = renderHook(() => useBrowserPaneActs());

    act(() => {
      result.current.run(first.run, FALLBACK);
      result.current.run(second.run, FALLBACK);
    });
    second.refuseWith(PORT_REFUSAL);
    await settle();
    first.serve();
    await settle();

    expect(result.current.refusal?.code).toBe("wire-unregistered");
  });

  it("lets a local refusal outrank an act dispatched before it", async () => {
    // The address guard and the close-tab chord settle without crossing the
    // boundary, and they are the newest thing the person did when they settle.
    const pending = deferredAct();
    const { result } = renderHook(() => useBrowserPaneActs());

    act(() => {
      result.current.run(pending.run, FALLBACK);
    });
    act(() => {
      result.current.refuseLocally("filesystem-destination", "Web destinations only.");
    });
    pending.serve();
    await settle();

    expect(result.current.refusal?.code).toBe("filesystem-destination");
  });

  it("keeps reporting the act that was already in flight when a banner was dismissed", async () => {
    // Dismissal says "I have read this", not "I have started something newer". An
    // act still running is the newest thing the pane is doing and its failure is news.
    const pending = deferredAct();
    const { result } = renderHook(() => useBrowserPaneActs());

    act(() => {
      result.current.run(pending.run, FALLBACK);
    });
    act(() => {
      result.current.dismiss();
    });
    pending.reject(new Error("the call never answered"));
    await settle();

    expect(result.current.refusal?.code).toBe("navigation-call-failed");
  });

  it("negative control: the newest act's own rejection is rendered", async () => {
    // Without this, a sequence that wrote nothing ever would satisfy the two
    // dropping cases above and would leave every failed act silent.
    const only = deferredAct();
    const { result } = renderHook(() => useBrowserPaneActs());

    act(() => {
      result.current.run(only.run, FALLBACK);
    });
    only.reject({ code: "permission_denied", message: "You may not navigate this pane." });
    await settle();

    expect(result.current.refusal?.code).toBe("permission_denied");
    expect(result.current.refusal?.detail).toBe("You may not navigate this pane.");
  });
});
