// The composer chord, pressed in the window that HAS the composer.
//
// The defect this pins is the one that made the chord look implemented and do
// nothing: the chord string existed, the main process watched for it in auxiliary
// windows, and no binding anywhere in the renderer ran the seam that moves the caret.
// A person in the main window pressed it and nothing happened, in silence — no
// refusal, no banner, no console line, because a chord nobody bound is
// indistinguishable from a chord that was handled.
//
// DRIVEN THROUGH THE REAL COMPOSITION ROOT AND A REAL DISPATCHED PRESS, on
// `frame-commands.contributions.test.tsx`'s rule beside this file: what is claimed is
// that the table this window installs answers the chord, and reading the binding list
// out of a hook would assert this file's own import against itself.
//
// THE MODIFIER IS RESOLVED, NOT GUESSED. `$mod` is command on macOS and control
// everywhere else, and the resolution here goes through the same shared function the
// main process uses — so a case that passed by trying both modifiers, and would have
// gone on passing if the table had bound the wrong one, is not what this is.

import { act } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { composerChordPrimaryModifier } from "../../../../shared/composer-chord.js";
import { CONSOLE_CHORD_PLATFORM } from "../palette/index.js";
import { subscribeToComposerFocus } from "../seats/index.js";
import { mountConsole } from "./composition/ConsoleRoot.test-support.js";

const openSubscriptions: (() => void)[] = [];

/** Stand in for a mounted composer, and remember the teardown. */
function listenForComposerFocus(takeFocus: () => void): void {
  openSubscriptions.push(subscribeToComposerFocus(takeFocus));
}

/**
 * Press one key on the window, with this host's `$mod` held or without it.
 *
 * `code` rather than `key`, because the chord is spelled with the physical key —
 * which is what keeps the binding on the same key under a layout that prints
 * something else there.
 */
function pressKey(code: string, options: { readonly withPrimaryModifier: boolean }): void {
  const usesMeta = composerChordPrimaryModifier(CONSOLE_CHORD_PLATFORM) === "meta";
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
    const mounted = await mountConsole();
    listenForComposerFocus(takeFocus);

    pressKey("KeyL", { withPrimaryModifier: true });

    expect(takeFocus).toHaveBeenCalledTimes(1);

    act(() => {
      mounted.unmount();
    });
  });

  it("negative control: a bare press of the same key asks for nothing", async () => {
    // Typing an `l` into the window is not a request for the composer. Without this,
    // a table that had bound the key with no modifier would satisfy the case above.
    const takeFocus = vi.fn();
    const mounted = await mountConsole();
    listenForComposerFocus(takeFocus);

    pressKey("KeyL", { withPrimaryModifier: false });

    expect(takeFocus).not.toHaveBeenCalled();

    act(() => {
      mounted.unmount();
    });
  });

  it("negative control: the modifier held with another key asks for nothing", async () => {
    // The other half. A table that answered every modified press would pass the
    // first case, and would take a chord a family bound to something else.
    const takeFocus = vi.fn();
    const mounted = await mountConsole();
    listenForComposerFocus(takeFocus);

    pressKey("KeyJ", { withPrimaryModifier: true });

    expect(takeFocus).not.toHaveBeenCalled();

    act(() => {
      mounted.unmount();
    });
  });

  it("stops answering the chord once the window is gone", async () => {
    // The listener the frame installs is withdrawn by its own effect cleanup. A
    // leaked one goes on asking a composer that unmounted with the window, which is
    // the shape a stray listener always takes.
    const takeFocus = vi.fn();
    const mounted = await mountConsole();
    listenForComposerFocus(takeFocus);
    act(() => {
      mounted.unmount();
    });

    pressKey("KeyL", { withPrimaryModifier: true });

    expect(takeFocus).not.toHaveBeenCalled();
  });
});
