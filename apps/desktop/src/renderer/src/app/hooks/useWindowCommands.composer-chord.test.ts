// The composer chord, pressed in the window that has the composer. An unbound chord fails
// silently (no refusal, banner or console line), so the case is driven through the real
// composition root and a dispatched press, which proves the table this window installs answers
// the chord. `$mod` is resolved through the renderer's one modifier table, not by trying both
// modifiers, which would pass even if the table bound the wrong one.

import { act } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { HOST_CHORD_PLATFORM, PLATFORM_MODIFIER_TOKEN } from "@renderer/lib/chord-format.js";
import { subscribeToComposerFocus } from "@renderer/features/composer/composer-focus-requests.js";
import { mountApp } from "@test/helpers/mount-app.js";

const openSubscriptions: (() => void)[] = [];

/** Stand in for a mounted composer, and remember the teardown. */
function listenForComposerFocus(takeFocus: () => void): void {
  openSubscriptions.push(subscribeToComposerFocus(takeFocus));
}

/**
 * Press one key on the window, with this host's `$mod` held or without it.
 *
 * `code` rather than `key`, because the chord names the physical key, which keeps it on the same
 * key under a layout that prints something else there.
 */
function pressKey(code: string, options: { readonly withPrimaryModifier: boolean }): void {
  const usesMeta = PLATFORM_MODIFIER_TOKEN[HOST_CHORD_PLATFORM] === "Meta";
  window.dispatchEvent(
    new KeyboardEvent("keydown", {
      code,
      key: code === "KeyL" ? "l" : "j",
      metaKey: options.withPrimaryModifier && usesMeta,
      ctrlKey: options.withPrimaryModifier && !usesMeta,
    }),
  );
}

afterEach(() => {
  while (openSubscriptions.length > 0) {
    openSubscriptions.pop()?.();
  }
});

describe("the composer chord in the window that has the composer", () => {
  it("asks the mounted composer for the caret", async () => {
    const takeFocus = vi.fn();
    const mounted = await mountApp();
    listenForComposerFocus(takeFocus);

    pressKey("KeyL", { withPrimaryModifier: true });

    expect(takeFocus).toHaveBeenCalledTimes(1);

    act(() => {
      mounted.unmount();
    });
  });

  it("negative control: a bare press of the same key asks for nothing", async () => {
    // Typing an `l` is not a request for the composer; a table that bound the bare key would
    // pass the case above.
    const takeFocus = vi.fn();
    const mounted = await mountApp();
    listenForComposerFocus(takeFocus);

    pressKey("KeyL", { withPrimaryModifier: false });

    expect(takeFocus).not.toHaveBeenCalled();

    act(() => {
      mounted.unmount();
    });
  });

  it("negative control: the modifier held with another key asks for nothing", async () => {
    // A table that answered every modified press would pass the first case.
    const takeFocus = vi.fn();
    const mounted = await mountApp();
    listenForComposerFocus(takeFocus);

    pressKey("KeyJ", { withPrimaryModifier: true });

    expect(takeFocus).not.toHaveBeenCalled();

    act(() => {
      mounted.unmount();
    });
  });

  it("stops answering the chord once the window is gone", async () => {
    // The frame's effect cleanup withdraws its listener; a leaked one would keep asking a
    // composer that unmounted with the window.
    const takeFocus = vi.fn();
    const mounted = await mountApp();
    listenForComposerFocus(takeFocus);
    act(() => {
      mounted.unmount();
    });

    pressKey("KeyL", { withPrimaryModifier: true });

    expect(takeFocus).not.toHaveBeenCalled();
  });
});
