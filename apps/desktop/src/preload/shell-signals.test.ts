// The relay: what the renderer's subscription actually does to `ipcRenderer`.
//
// Three properties, and each one is a way the seam fails silently rather than
// loudly. It has to listen on the SAME channel main sends on, or every request is
// delivered to nobody and the chord looks like it did nothing. It has to call the
// handler with NOTHING, or a handler that took the argument would be handed
// Electron's `IpcRendererEvent` — which carries `sender`, a capability the renderer
// must never hold and a value `contextBridge` refuses to clone. And the disposer has
// to remove the LISTENER IT ADDED, or every window that ever unmounted a console
// leaves one behind and the process accumulates them for its lifetime.
//
// The second describe is about the composition itself — that this preload really
// hands the relay to the factory. It is the one assembly step in the whole file, and
// getting it wrong is invisible from either side alone: the relay would still pass
// every case above, and the bridge would still carry a `shell` namespace.

import { describe, expect, it, vi } from "vitest";

import { NotImplementedError, createStubBridge } from "@ai-sidekicks/contracts";

import { COMPOSER_FOCUS_REQUEST_CHANNEL } from "../shared/composer-chord.js";
import { createShellSignals, type ShellSignalReceiver } from "./shell-signals.js";

/** A receiver that records, and can raise what main would have sent. */
class ReceiverProbe {
  readonly #listeners = new Map<string, Set<(...payload: readonly unknown[]) => void>>();

  /** The two methods the relay is allowed to use, shaped as Electron's. */
  readonly receiver: ShellSignalReceiver = {
    on: (channel, listener) => {
      const forChannel = this.#listeners.get(channel) ?? new Set();
      forChannel.add(listener as (...payload: readonly unknown[]) => void);
      this.#listeners.set(channel, forChannel);
      return this.receiver as never;
    },
    removeListener: (channel, listener) => {
      this.#listeners.get(channel)?.delete(listener as (...payload: readonly unknown[]) => void);
      return this.receiver as never;
    },
  };

  /** Deliver on a channel exactly as Electron does — event first, then arguments. */
  send(channel: string, ...payload: readonly unknown[]): void {
    for (const listener of this.#listeners.get(channel) ?? []) {
      listener({ senderId: 1 }, ...payload);
    }
  }

  listenerCount(channel: string): number {
    return this.#listeners.get(channel)?.size ?? 0;
  }
}

describe("the shell relay in the preload", () => {
  it("listens on the channel main sends the composer-focus request on", () => {
    const probe = new ReceiverProbe();
    const askedForTheCaret = vi.fn();
    createShellSignals(probe.receiver).subscribeToComposerFocusRequest(askedForTheCaret);

    probe.send(COMPOSER_FOCUS_REQUEST_CHANNEL);

    expect(askedForTheCaret).toHaveBeenCalledTimes(1);
  });

  it("negative control: a request on any other channel reaches nobody", () => {
    // Without this, a relay listening on `"*"`-ish or on a second spelling would pass
    // the case above and answer traffic that was never about the composer.
    const probe = new ReceiverProbe();
    const askedForTheCaret = vi.fn();
    createShellSignals(probe.receiver).subscribeToComposerFocusRequest(askedForTheCaret);

    probe.send("sidekicks:some-other-signal");

    expect(askedForTheCaret).not.toHaveBeenCalled();
  });

  it("hands the handler no arguments at all", () => {
    // The `sender` on Electron's event is the capability this drops. A relay that
    // forwarded its arguments would work in this test's shape and throw a clone error
    // the first time it ran across a real `contextBridge`.
    const probe = new ReceiverProbe();
    const askedForTheCaret = vi.fn();
    createShellSignals(probe.receiver).subscribeToComposerFocusRequest(askedForTheCaret);

    probe.send(COMPOSER_FOCUS_REQUEST_CHANNEL, "a payload nobody declared");

    expect(askedForTheCaret).toHaveBeenCalledWith();
  });

  it("removes the listener it added, and only that one", () => {
    const probe = new ReceiverProbe();
    const signals = createShellSignals(probe.receiver);
    const firstWindow = signals.subscribeToComposerFocusRequest(vi.fn());
    const stillOpen = vi.fn();
    signals.subscribeToComposerFocusRequest(stillOpen);

    firstWindow();

    expect(probe.listenerCount(COMPOSER_FOCUS_REQUEST_CHANNEL)).toBe(1);
    probe.send(COMPOSER_FOCUS_REQUEST_CHANNEL);
    expect(stillOpen).toHaveBeenCalledTimes(1);
  });
});

describe("the bridge this preload composes", () => {
  it("serves the shell namespace from the relay rather than from the factory's default", () => {
    const probe = new ReceiverProbe();
    const askedForTheCaret = vi.fn();
    const bridge = createStubBridge(createShellSignals(probe.receiver));

    bridge.shell.subscribeToComposerFocusRequest(askedForTheCaret);
    probe.send(COMPOSER_FOCUS_REQUEST_CHANNEL);

    expect(askedForTheCaret).toHaveBeenCalledTimes(1);
  });

  it("negative control: a bridge built with no shell refuses the subscription", () => {
    // What the case above is worth. The factory's default REFUSES rather than
    // reporting nothing, so a preload that stopped passing the relay fails loudly at
    // the window's first subscription — not silently, for a session, on every ask.
    expect(() => createStubBridge().shell.subscribeToComposerFocusRequest(vi.fn())).toThrow(
      NotImplementedError,
    );
  });
});
