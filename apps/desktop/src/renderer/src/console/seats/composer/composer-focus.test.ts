// The ask reaches whoever is mounted, and nobody otherwise.
//
// The claim worth testing is the one a queue would break: an ask with no composer
// mounted is DROPPED. A buffered ask replayed at the next mount moves the caret out
// from under whatever the person started doing instead, seconds after they asked for
// something else — which is worse than the ask doing nothing.
//
// The second half of this file is the SHELL's ingress into that same seam. A composer
// chord pressed in an auxiliary window is answered by the main process, which brings
// this window forward and then asks it for the caret over the bridge — and what is
// checkable here is that the ask lands in this emitter rather than beside it, and that
// the window releases the subscription when it closes.

import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { shellProbe } from "../../bridge/shell-signals.test-support.js";
import {
  composerFocusListenerCount,
  requestComposerFocus,
  subscribeToComposerFocus,
  useShellComposerFocusRequests,
} from "./composer-focus.js";

const openSubscriptions: (() => void)[] = [];

/** Subscribe and remember the teardown, so no case leaks a sink into the next. */
function listen(takeFocus: () => void): void {
  openSubscriptions.push(subscribeToComposerFocus(takeFocus));
}

afterEach(() => {
  while (openSubscriptions.length > 0) {
    openSubscriptions.pop()?.();
  }
  expect(composerFocusListenerCount()).toBe(0);
});

describe("asking the mounted composer for the caret", () => {
  it("reaches the subscriber", () => {
    const takeFocus = vi.fn();
    listen(takeFocus);

    requestComposerFocus();

    expect(takeFocus).toHaveBeenCalledTimes(1);
  });

  it("reaches it once per ask and never on its own", () => {
    const takeFocus = vi.fn();
    listen(takeFocus);

    requestComposerFocus();
    requestComposerFocus();

    expect(takeFocus).toHaveBeenCalledTimes(2);
  });

  it("carries nothing, so what focusing means stays the composer's", () => {
    const takeFocus = vi.fn();
    listen(takeFocus);

    requestComposerFocus();

    expect(takeFocus).toHaveBeenCalledWith();
  });
});

describe("an ask nobody is listening for", () => {
  it("does not throw", () => {
    expect(() => {
      requestComposerFocus();
    }).not.toThrow();
  });

  it("is dropped rather than replayed at the next mount", () => {
    // The behaviour a buffer would defeat: the caret must not jump into a composer
    // that mounted after the ask, because by then the person is somewhere else.
    requestComposerFocus();
    const takeFocus = vi.fn();
    listen(takeFocus);

    expect(takeFocus).not.toHaveBeenCalled();
  });

  it("stops reaching a composer that has unsubscribed", () => {
    const takeFocus = vi.fn();
    const unsubscribe = subscribeToComposerFocus(takeFocus);
    unsubscribe();

    requestComposerFocus();

    expect(takeFocus).not.toHaveBeenCalled();
  });
});

describe("the shell asking this window's composer for the caret", () => {
  it("lands in the same seam a surface's ask does", () => {
    // The whole reason the ingress is here. A chord pressed in an auxiliary window
    // and a runs-pane empty state both mean "put the caret in the composer", and the
    // composer answers exactly one subscription — so a second path for the shell
    // would be a second answer, free to drift from this one the first time either
    // changed.
    const takeFocus = vi.fn();
    const shell = shellProbe();
    listen(takeFocus);
    const mounted = renderHook(() => {
      useShellComposerFocusRequests(shell.bridge);
    });

    shell.raiseComposerFocusRequest();

    expect(takeFocus).toHaveBeenCalledTimes(1);
    mounted.unmount();
  });

  it("negative control: a window that raised no request moves no caret", () => {
    // Without this, a binding that asked for the caret on mount — a plausible way to
    // get the case above green — would look identical, and every window would open
    // with the caret yanked into the composer.
    const takeFocus = vi.fn();
    const shell = shellProbe();
    listen(takeFocus);
    const mounted = renderHook(() => {
      useShellComposerFocusRequests(shell.bridge);
    });

    expect(takeFocus).not.toHaveBeenCalled();
    mounted.unmount();
  });

  it("releases the bridge subscription when the window closes", () => {
    // A window that closed while holding one leaves the shell delivering into a
    // handler whose composer is gone — and, on the live bridge, an `ipcRenderer`
    // listener that accumulates one per window opened.
    const shell = shellProbe();
    const mounted = renderHook(() => {
      useShellComposerFocusRequests(shell.bridge);
    });

    expect(shell.openSubscriptionCount()).toBe(1);
    mounted.unmount();
    expect(shell.openSubscriptionCount()).toBe(0);
  });
});
