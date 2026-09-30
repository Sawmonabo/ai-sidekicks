// The ask reaches whoever is mounted, and nobody otherwise. An ask with no composer mounted is
// dropped: a buffered one would move the caret out from under whatever the person moved on to.

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  composerFocusListenerCount,
  requestComposerFocus,
  subscribeToComposerFocus,
} from "./composer-focus-requests.js";

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
    // The caret must not jump into a composer that mounted after the ask.
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
