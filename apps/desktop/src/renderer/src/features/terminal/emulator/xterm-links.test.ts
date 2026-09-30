// Printed URLs, not just the hyperlinks a program marked. Every case writes a line through the
// real parser and asks the registered provider what it offers for that row. The scheme
// allow-list is the second gate: a refused scheme is offered as no link at all.

import { afterEach, describe, expect, it, vi } from "vitest";

import { Terminal, type ILink, type ILinkProvider } from "@xterm/xterm";

import { TerminalRendererPool } from "./renderer-pool.js";
import { XtermTerminalAdapter } from "./xterm-adapter.js";

import {
  attachedMountElement,
  disposeLiveEmulators,
  trackAdapter,
  writeText,
} from "./xterm-adapter.test-support.js";

afterEach(disposeLiveEmulators);

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
      // Raised rather than answered with an empty list, so the refusal cases cannot pass
      // vacuously.
      throw new Error("the adapter registered no link provider");
    }
    await writeText(builtAdapter, `${line}\n`);
    return linksOnRow(linkProvider, 1);
  }

  it("offers a printed https URL as an activatable link", async () => {
    const opened = vi.fn();
    const links = await linksPrintedBy("see https://example.test/a for details", opened);
    expect(links).toHaveLength(1);
    expect(links[0]?.text).toBe("https://example.test/a");

    links[0]?.activate(new MouseEvent("click"), links[0].text);
    expect(opened).toHaveBeenCalledWith("https://example.test/a");
  });

  it("hands the opener the PARSED href, so the guard is on the path", async () => {
    const opened = vi.fn();
    const links = await linksPrintedBy("http://example.test", opened);
    links[0]?.activate(new MouseEvent("click"), links[0]?.text ?? "");
    // The printed text has no trailing slash and the parsed href does, so this shows the
    // allow-list ran.
    expect(opened).toHaveBeenCalledWith("http://example.test/");
  });

  it("offers no link at all for a scheme the allow-list refuses", async () => {
    const opened = vi.fn();
    // What an attacker-controlled program prints. Nothing is decorated, so the guard is the
    // second gate, not the only one.
    const links = await linksPrintedBy("javascript:alert(1) file:///etc/passwd", opened);
    expect(links).toStrictEqual([]);
    expect(opened).not.toHaveBeenCalled();
  });

  it("registers no provider for a terminal with nowhere to send a link", async () => {
    // An underlined URL whose click does nothing is an affordance that lies, so the
    // provider is gated on the sink the way `onData` is gated on the writer.
    const mountElement = attachedMountElement();
    const registered = recordLinkProvidersRegisteredBy(() => {
      const adapter = trackAdapter(
        new XtermTerminalAdapter({
          terminalId: "no-link-sink",
          pool: new TerminalRendererPool(),
        }),
      );
      adapter.attach(mountElement);
      return adapter;
    });
    expect(registered).toStrictEqual([]);
  });

  it("negative control: the recorder sees nothing when no provider is registered", async () => {
    // Without this the cases above could pass against a recorder that reported a provider the
    // adapter never registered.
    const opened = vi.fn();
    const adapter = trackAdapter(
      new XtermTerminalAdapter({
        terminalId: "unwatched",
        pool: new TerminalRendererPool(),
        onActivateLink: opened,
      }),
    );
    const registered = recordLinkProvidersRegisteredBy(() => adapter);
    expect(registered).toStrictEqual([]);
  });
});
