// Who the lease fold is told is looking, and what the pane does with each answer.
//
// Three arms, and the pane behaves differently on all three: the claimant's own hold
// offers the handback and names the surface "no input channel"; somebody else's hold
// offers the claim; and a REFUSED identity read withholds the control entirely rather
// than offering an act the console could not attribute — while still showing who the
// log says holds the shell, because the withholding is about the control and not about
// the reading.

import { waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { TERMINAL_SCENARIO_CAST } from "../../bridge/scenarios/terminal.js";
import {
  bridgeAnsweringCallerWith,
  bridgeRefusingCaller,
  renderPane,
  storeThrough,
} from "./TerminalPane.test-support.js";

describe("terminal pane — the viewer the lease fold is told about", () => {
  /** The claim control, or `null` — which is the whole point of two of these cases. */
  function claimControl(region: HTMLElement): Element | null {
    return region.querySelector(".meridian-lease-line__claim");
  }

  function writeEnabled(region: HTMLElement): string | null | undefined {
    return region.querySelector(".meridian-terminal-host")?.getAttribute("data-write-enabled");
  }

  /**
   * The emulator surface's accessible name, which carries the host's write gate.
   *
   * Read rather than `data-write-enabled`, because that attribute answers only
   * whether the surface is writable and this pane's is not: the byte stream is a
   * growth-slate row, so `XtermHost` has nowhere to send a keystroke and holds the
   * surface read-only whatever the lease says. The NAME tells the two read-only
   * states apart, which is exactly the distinction the lease's viewer decides.
   */
  async function surfaceName(region: HTMLElement): Promise<string | null> {
    let name: string | null = null;
    await waitFor(() => {
      name =
        region.querySelector(".meridian-terminal-host__surface")?.getAttribute("aria-label") ??
        null;
      expect(name).not.toBeNull();
    });
    return name;
  }

  it("reads the claimant's own take as theirs, and offers them the handback", async () => {
    // The scenario's first transition is a `taken` by the owner. Told that this
    // window IS the owner, the fold answers `held-by-you` — which is exactly what the
    // hard-coded `undefined` made unreachable.
    const region = renderPane(
      storeThrough(1),
      bridgeAnsweringCallerWith(TERMINAL_SCENARIO_CAST.owner),
    );
    await waitFor(() => {
      expect(region.textContent).toContain("You may type into the shared shell.");
    });
    expect(claimControl(region)?.textContent).toBe("Release the shell");
    // The lease reached the host: the read-only state is now "nowhere to send what
    // you type" rather than "somebody else holds it".
    expect(await surfaceName(region)).toBe("Terminal output, read-only: no input channel");
  });

  it("negative control: the same log with another viewer is somebody else's hold", async () => {
    // Without this the case above would pass against a pane that reported every held
    // lease as the viewer's. Same store, same transition, a different answer to the
    // one read that changed.
    const region = renderPane(
      storeThrough(1),
      bridgeAnsweringCallerWith(TERMINAL_SCENARIO_CAST.collaborator),
    );
    await waitFor(() => {
      expect(claimControl(region)).not.toBeNull();
    });
    expect(region.textContent).toContain("Held by");
    expect(region.textContent).not.toContain("You may type into the shared shell.");
    expect(claimControl(region)?.textContent).toBe("Claim the shell");
    expect(writeEnabled(region)).toBe("false");
    expect(await surfaceName(region)).toBe("Terminal output, read-only");
  });

  it("withholds the claim control and renders the refusal when the read is refused", async () => {
    // The port's own refusal — the answer a live bridge gives while the identity
    // wire is unregistered. A pane that offered the control anyway would be
    // offering an act it could not attribute — and the daemon would honour it.
    const region = renderPane(storeThrough(1), bridgeRefusingCaller());
    await waitFor(() => {
      expect(region.querySelector(".meridian-lease-line .meridian-refusal--inline")).not.toBeNull();
    });
    expect(claimControl(region)).toBeNull();
    // The wire's own code and sentence, and the console's next move beside them.
    expect(region.textContent).toContain("not registered on this build yet");
    expect(region.textContent).toContain("offered again once the console can say");
    expect(writeEnabled(region)).toBe("false");
  });

  it("negative control: a refused identity still shows the log's holder", async () => {
    // The withholding is about the CONTROL, not about the reading. A pane that had
    // blanked the lease line would pass the case above and tell nobody who holds the
    // shell.
    const region = renderPane(storeThrough(1), bridgeRefusingCaller());
    await waitFor(() => {
      expect(region.querySelector(".meridian-lease-line .meridian-refusal--inline")).not.toBeNull();
    });
    expect(region.textContent).toContain("Held by");
    expect(region.textContent).toContain(TERMINAL_SCENARIO_CAST.owner);
  });
});
