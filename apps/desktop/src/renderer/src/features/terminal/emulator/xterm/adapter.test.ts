// The emulator wrapper: scrollback kept across a move, the buffer released on
// teardown, the write gate on the library's own `disableStdin`, and printed links held to the
// scheme allow-list. Sending a keystroke nobody was allowed to send is the expensive mistake on
// a shared shell, so the gate is also shut while the emulator has no mount element.

import { afterEach, describe, expect, it, vi } from "vitest";

import { Terminal, type ILink, type ILinkProvider } from "@xterm/xterm";

import { TerminalRendererPool } from "../renderer-pool.js";
import { XtermTerminalAdapter } from "./adapter.js";
import {
  attachedMountElement,
  disposeLiveEmulators,
  emulatorElementsIn,
  mountedAdapter,
  trackAdapter,
  writeText,
} from "./adapter.test-support.js";

afterEach(disposeLiveEmulators);

describe("the emulator wrapper", () => {
  it("re-appends that same emulator on the next mount element, scrollback and all", async () => {
    // The element leaves and the emulator does not. `open()` returns early for a terminal that
    // already has an element, so the re-append is the adapter's own; a second element would
    // show up as two grids.
    const { adapter, mountElement } = mountedAdapter({ terminalId: "moved-on" });
    await writeText(adapter, "printed before the move\n");
    const nextMountElement = attachedMountElement();

    adapter.detach();
    adapter.attach(nextMountElement);

    expect(emulatorElementsIn(mountElement)).toHaveLength(0);
    expect(emulatorElementsIn(nextMountElement)).toHaveLength(1);
    expect(adapter.serialize()).toContain("printed before the move");
    expect(adapter.isEmulatorLive).toBe(true);
  });
});

describe("teardown", () => {
  it("refuses to come back after disposal", () => {
    const { adapter, mountElement } = mountedAdapter();
    adapter.dispose();
    adapter.attach(mountElement);
    expect(adapter.isEmulatorLive).toBe(false);
  });

  it("lets go of the addons, which is what lets go of the buffer", async () => {
    const { adapter } = mountedAdapter();
    await writeText(adapter, "a line the serializer can see\n");
    // Live: the addon APIs answer, so the emulator behind them is reachable.
    expect(adapter.serialize()).toContain("a line the serializer can see");

    adapter.dispose();

    // Disposed: they answer their empty value. An addon kept as a field would outlive
    // `#terminal` and hold the whole emulator (measured: almost all of a full instance's bytes
    // survived a teardown; `tests/endurance/xterm-adapter.test.ts` holds it).
    expect(adapter.serialize()).toBe("");
    expect(adapter.findNext("a line the serializer can see")).toBe(false);
  });
});

describe("the write gate — watch mode is the default", () => {
  it("moves the library's own gate, not just its own field", () => {
    const { adapter } = mountedAdapter();
    expect(adapter.isStdinDisabled).toBe(true);
    adapter.setWriteEnabled(true);
    expect(adapter.isWriteEnabled).toBe(true);
    expect(adapter.isStdinDisabled).toBe(false);
    adapter.setWriteEnabled(false);
    expect(adapter.isStdinDisabled).toBe(true);
  });

  it(
    "shuts the gate while the emulator is off screen and re-opens it " +
      "on the next mount element",
    () => {
      // The write state belongs to the tie: a detached emulator has no box to click, so an open
      // gate there accepts input nobody can see, and the next mount element gets the lease's
      // answer without being told again.
      const { adapter, mountElement } = mountedAdapter({ terminalId: "gated-by-mount" });
      adapter.setWriteEnabled(true);
      expect(adapter.isStdinDisabled).toBe(false);

      adapter.detach();

      expect(adapter.isWriteEnabled).toBe(false);
      expect(adapter.isStdinDisabled).toBe(true);

      adapter.attach(mountElement);

      expect(adapter.isWriteEnabled).toBe(true);
      expect(adapter.isStdinDisabled).toBe(false);
    },
  );

  it("keeps a watcher's gate shut across a detach and re-attach", () => {
    // A re-attach restores the lease's answer; it never opens stdin on its own.
    const { adapter, mountElement } = mountedAdapter({ terminalId: "watcher-remount" });

    adapter.detach();
    adapter.attach(mountElement);

    expect(adapter.isWriteEnabled).toBe(false);
    expect(adapter.isStdinDisabled).toBe(true);
  });
});

/**
 * Every link provider the adapter registers on its own terminal, in order. xterm.js registers
 * its OSC 8 provider through an internal service, so this records only what the adapter
 * registered; the original is still called.
 */
function recordLinkProvidersRegisteredBy(build: () => XtermTerminalAdapter): ILinkProvider[] {
  const registered: ILinkProvider[] = [];
  const register = Terminal.prototype.registerLinkProvider;
  const watch = vi.spyOn(Terminal.prototype, "registerLinkProvider").mockImplementation(function (
    this: Terminal,
    linkProvider: ILinkProvider,
  ) {
    registered.push(linkProvider);
    return register.call(this, linkProvider);
  });
  try {
    build();
  } finally {
    watch.mockRestore();
  }
  return registered;
}

/** The links one provider offers for one buffer row. `y` is one-based, as xterm counts. */
function linksOnRow(linkProvider: ILinkProvider, row: number): ILink[] {
  let offered: ILink[] = [];
  linkProvider.provideLinks(row, (links) => {
    offered = links ?? [];
  });
  return offered;
}

// Printed URLs, not just the hyperlinks a program marked: each case writes a line through the
// real parser and asks the registered provider what it offers for that row.
describe("printed URLs, not just the hyperlinks a program marked", () => {
  /** Write one line and hand back the links the adapter's provider offers for it. */
  async function linksPrintedBy(
    line: string,
    onActivateLink: (url: string) => void,
  ): Promise<ILink[]> {
    const mountElement = attachedMountElement();
    // Held by the closure: the adapter written into must be the one the recorder watched.
    let builtAdapter: XtermTerminalAdapter | undefined;
    const [linkProvider] = recordLinkProvidersRegisteredBy(() => {
      const adapter = trackAdapter(
        new XtermTerminalAdapter({
          terminalId: "links",
          pool: new TerminalRendererPool(),
          onActivateLink,
        }),
      );
      adapter.attach(mountElement);
      builtAdapter = adapter;
      return adapter;
    });
    if (linkProvider === undefined || builtAdapter === undefined) {
      // Raised rather than answered with an empty list, so a missing provider fails the case.
      throw new Error("the adapter registered no link provider");
    }
    await writeText(builtAdapter, `${line}\n`);
    return linksOnRow(linkProvider, 1);
  }

  it("hands the opener the PARSED href, so the guard is on the path", async () => {
    const opened = vi.fn();
    const links = await linksPrintedBy("http://example.test", opened);
    links[0]?.activate(new MouseEvent("click"), links[0]?.text ?? "");
    // The printed text has no trailing slash and the parsed href does, so this shows the
    // allow-list ran.
    expect(opened).toHaveBeenCalledWith("http://example.test/");
  });
});
