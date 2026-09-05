// Printed URLs, not just the hyperlinks a program marked.
//
// The link modules register a provider on the terminal and read text back out of the
// buffer, so every case here writes a line through the real parser and asks the
// provider what it offers for that row — which makes these claims about a shell
// printing a URL rather than about a regular expression. The scheme allow-list is
// the second gate: a refused scheme is offered as no link at all, so there is
// nothing to click.
//
// Against the real library, and cleaned up through the directory's one live-emulator
// registry — see `xterm-adapter.test-support.ts` for both reasons.

import { afterEach, describe, expect, it, vi } from "vitest";

import { Terminal, type ILink, type ILinkProvider } from "@xterm/xterm";

import { TerminalRendererPool } from "./renderer-pool.js";
import { XtermTerminalAdapter } from "./xterm-adapter.js";

import {
  attachedHost,
  disposeLiveEmulators,
  trackAdapter,
  writeText,
} from "./xterm-adapter.test-support.js";

afterEach(disposeLiveEmulators);

/**
 * Every link provider the adapter registers on its own terminal, in order.
 *
 * The library's public `registerLinkProvider` is the only door an addon has, and
 * xterm.js registers its own OSC 8 provider through an internal service rather
 * than through it — so what this records is exactly what the ADAPTER registered,
 * and against the old adapter it records nothing. The original is still called, so
 * the emulator behaves as it does in the shell; this only watches the door.
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
  /**
   * Write one line and hand back the links the adapter's provider offers for it.
   *
   * The whole path, through the real emulator: the text goes through the parser,
   * lands in the buffer, and the provider reads it back out of that buffer — which
   * is what makes this a claim about a shell printing a URL rather than about a
   * regular expression.
   */
  async function linksPrintedBy(
    line: string,
    onActivateLink: (url: string) => void,
  ): Promise<ILink[]> {
    const host = attachedHost();
    // Held by the closure rather than read back off the live registry: the adapter
    // this line is written into has to be the one the recorder just watched, and the
    // newest tracked instance is only the same object by coincidence of ordering.
    let builtAdapter: XtermTerminalAdapter | undefined;
    const [linkProvider] = recordLinkProvidersRegisteredBy(() => {
      const adapter = trackAdapter(
        new XtermTerminalAdapter({
          terminalId: "links",
          pool: new TerminalRendererPool(),
          onActivateLink,
        }),
      );
      adapter.attach(host);
      builtAdapter = adapter;
      return adapter;
    });
    if (linkProvider === undefined || builtAdapter === undefined) {
      // Raised rather than answered with an empty list, so the refusal cases below
      // cannot pass vacuously. This is the old adapter's state for every case in
      // this block: `linkHandler` governs OSC 8 hyperlinks and registers no
      // provider, so printed text was offered as a link through no path at all.
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
    // The printed text has no trailing slash and the parsed href does. A handler
    // that forwarded the matched text untouched would answer without one, so this
    // is evidence the allow-list ran rather than that a callback fired.
    expect(opened).toHaveBeenCalledWith("http://example.test/");
  });

  it("offers no link at all for a scheme the allow-list refuses", async () => {
    const opened = vi.fn();
    // A terminal renders whatever a process writes, so this line is what an
    // attacker-controlled program prints. Nothing is decorated, so there is nothing
    // to click — the guard is the second gate and not the only one.
    const links = await linksPrintedBy("javascript:alert(1) file:///etc/passwd", opened);
    expect(links).toStrictEqual([]);
    expect(opened).not.toHaveBeenCalled();
  });

  it("registers no provider for a surface with nowhere to send a link", async () => {
    // An underlined URL whose click does nothing is an affordance that lies, so the
    // provider is gated on the sink the way `onData` is gated on the writer.
    const host = attachedHost();
    const registered = recordLinkProvidersRegisteredBy(() => {
      const adapter = trackAdapter(
        new XtermTerminalAdapter({
          terminalId: "no-link-sink",
          pool: new TerminalRendererPool(),
        }),
      );
      adapter.attach(host);
      return adapter;
    });
    expect(registered).toStrictEqual([]);
  });

  it("negative control: the recorder sees nothing when no provider is registered", async () => {
    // Which is also the old adapter's behaviour for every case above — printed text
    // reached `onActivateLink` through no path, because no provider existed to
    // offer it. Without this the cases above could pass against a recorder that
    // reported a provider the adapter never registered.
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
