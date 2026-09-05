// Which answer the pane is allowed to render, when two acts are in flight.
//
// Every case here is an ordering, so each one settles its acts DELIBERATELY out of
// the order they were dispatched in — a suite that awaited each act before starting
// the next would exercise a sequence that cannot go wrong and would pass against the
// defect. The pair that matters is symmetric: an older failure must not displace a
// newer success, and an older success must not clear a newer failure.

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { BROWSER_SCENARIO } from "../../bridge/scenarios/browser.js";
import { createFixtureBridge, type ConsoleBridge } from "../../bridge/index.js";
import { refuse, type ConsoleRefusal } from "../../core/index.js";
import { useBrowserPaneActs, type BrowserPaneActs } from "./act-sequence.js";

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

/** The subject an act belongs to: which bridge it went out on, and for which pane. */
interface ActSubject {
  readonly bridge: ConsoleBridge;
  readonly paneId: string;
}

function subject(paneId: string, bridge?: ConsoleBridge): ActSubject {
  return { bridge: bridge ?? createFixtureBridge({ scenario: BROWSER_SCENARIO }), paneId };
}

/**
 * The hook under one subject, with the re-render that hands it another.
 *
 * `renderHook`'s props are the whole point here: a deck rebinding a slot keeps the
 * hook instance and changes its inputs, and a suite that could only mount a fresh
 * hook would never reach the interval this module's stamp exists for.
 */
function renderActs(initial: ActSubject): {
  readonly acts: () => BrowserPaneActs;
  readonly rebindTo: (next: ActSubject) => void;
} {
  const { result, rerender } = renderHook(
    (props: ActSubject) => useBrowserPaneActs(props.bridge, props.paneId),
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
      useBrowserPaneActs(FIRST_SUBJECT.bridge, FIRST_SUBJECT.paneId),
    );

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
    const { result } = renderHook(() =>
      useBrowserPaneActs(FIRST_SUBJECT.bridge, FIRST_SUBJECT.paneId),
    );

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
    const { result } = renderHook(() =>
      useBrowserPaneActs(FIRST_SUBJECT.bridge, FIRST_SUBJECT.paneId),
    );

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
    const { result } = renderHook(() =>
      useBrowserPaneActs(FIRST_SUBJECT.bridge, FIRST_SUBJECT.paneId),
    );

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
    const { result } = renderHook(() =>
      useBrowserPaneActs(FIRST_SUBJECT.bridge, FIRST_SUBJECT.paneId),
    );

    act(() => {
      result.current.run(only.run, FALLBACK);
    });
    only.reject({ code: "permission_denied", message: "You may not navigate this pane." });
    await settle();

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
    await settle();

    expect(acts().refusal).toBeUndefined();
  });

  it("drops a settlement that lands after the bridge was replaced", async () => {
    // The other half of the subject, and it fails the same way: a call made on a
    // bridge this window no longer holds cannot be reporting about the page it holds
    // now, whatever the pane is called.
    const pending = deferredAct();
    const { acts, rebindTo } = renderActs(FIRST_SUBJECT);

    act(() => {
      acts().run(pending.run, FALLBACK);
    });
    rebindTo(subject(FIRST_SUBJECT.paneId));
    pending.reject(new Error("the call never answered"));
    await settle();

    expect(acts().refusal).toBeUndefined();
  });

  it("clears a refusal already on screen when the pane is rebound", async () => {
    // The local arm, which never crosses the boundary and so cannot be dropped by a
    // token alone: the sentence was rendered and stayed rendered beside a pane it
    // was not about.
    const { acts, rebindTo } = renderActs(FIRST_SUBJECT);

    act(() => {
      acts().refuseLocally("filesystem-destination", "Web destinations only.");
    });
    expect(acts().refusal?.code).toBe("filesystem-destination");

    rebindTo(SECOND_SUBJECT);

    expect(acts().refusal).toBeUndefined();
  });

  it("still reports the replacement pane's own act", async () => {
    // The rebind retires the previous subject's acts; it does not retire the hook.
    const { acts, rebindTo } = renderActs(FIRST_SUBJECT);
    rebindTo(SECOND_SUBJECT);
    const afterRebind = deferredAct();

    act(() => {
      acts().run(afterRebind.run, FALLBACK);
    });
    afterRebind.refuseWith(PORT_REFUSAL);
    await settle();

    expect(acts().refusal?.code).toBe("wire-unregistered");
  });

  it("negative control: a re-render that keeps the subject keeps the refusal", async () => {
    // Without it every case above would pass against a hook that cleared its refusal
    // on any re-render — and a pane re-renders on every reported navigation, so the
    // refusal a person is reading would vanish while they read it.
    const { acts, rebindTo } = renderActs(FIRST_SUBJECT);

    act(() => {
      acts().refuseLocally("close-unregistered", "No close action is registered.");
    });
    rebindTo({ ...FIRST_SUBJECT });

    expect(acts().refusal?.code).toBe("close-unregistered");
  });
});
