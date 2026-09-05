// The output subscription: what a rejection leaves on screen, and which shell the
// reading belongs to.
//
// `.tsx` and rendered through the pane rather than driven as a bare hook, because
// `useTerminalOutputStream` has no meaning apart from the surface that consumes it:
// what the two halves below are about are the DISPLACEMENT of the typed absence by a
// refusal, and the re-ask on a rebind — both of them properties of the rendered pane.
//
// A rejection is not a refusal. The growth port ANSWERS a refusal, so a rejected
// promise means the bridge itself failed, and the two must not read the same: a denied
// permission and a torn transport are different next moves.
//
// And the reading is the SHELL's, not the pane's. A rebind to a different bridge or a
// different session store addresses a different shell, so the previous shell's refusal
// is a statement about a machine this pane has left.

import { render, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { ConsoleBridge } from "../../bridge/index.js";
import { SessionStore } from "../../store/index.js";
import { TerminalPane } from "./TerminalPane.js";
import {
  bridgeRejectingOutputWith,
  outputRefusal,
  paneBridge,
  paneRegionOf,
  renderPane,
  storeThrough,
} from "./TerminalPane.test-support.js";

describe("terminal pane — a rejected output subscribe keeps its diagnosis", () => {
  it("renders the wire's own code when the subscribe REJECTED rather than refused", async () => {
    const region = renderPane(
      storeThrough(1),
      bridgeRejectingOutputWith({
        code: "permission_denied",
        message: "You may not watch this session's shell.",
      }),
    );
    await waitFor(() => {
      expect(outputRefusal(region)).not.toBeNull();
    });
    // The half a person acts on. The old arm reduced this to a generic title with
    // the envelope serialized into the detail, so a denied permission and a torn
    // transport read the same.
    expect(region.textContent).toContain("permission_denied");
    expect(region.textContent).toContain("You may not watch this session's shell.");
    expect(region.textContent).not.toContain("could not be reached");
  });

  it("names the next move when the rejection carried no code of its own", async () => {
    const region = renderPane(
      storeThrough(1),
      bridgeRejectingOutputWith(new Error("the preload went away")),
    );
    await waitFor(() => {
      expect(outputRefusal(region)).not.toBeNull();
    });
    // The normalizer's fourth arm, and the only one this pane's fallback reaches:
    // a rejection with nothing to say gets a sentence that says what to do.
    expect(region.textContent).toContain("terminal-output-unreachable");
    expect(region.textContent).toContain("Reopening this pane asks again.");
  });

  it("negative control: the refusal displaces the absence rather than joining it", async () => {
    // Without this the cases above would pass against a pane that rendered both,
    // leaving "No output stream" on screen beside a refusal that contradicts it.
    const region = renderPane(
      storeThrough(1),
      bridgeRejectingOutputWith({ code: "permission_denied", message: "no" }),
    );
    await waitFor(() => {
      expect(outputRefusal(region)).not.toBeNull();
    });
    expect(region.textContent).not.toContain("No output stream");
    expect(region.textContent).not.toContain("Asking for the output stream");
  });

  it("negative control: the served-and-refused paths still render an absence", async () => {
    // And without this the cases above would pass against a pane that had turned
    // every output reading into a refusal, which would make the port's own typed
    // absence unreachable.
    const region = renderPane(storeThrough(1));
    await waitFor(() => {
      expect(region.textContent).toContain("No output stream");
    });
    expect(outputRefusal(region)).toBeNull();
  });
});

describe("terminal pane — the output reading belongs to the shell it was read for", () => {
  const PERMISSION_DENIED = {
    code: "pty.permission_denied",
    message: "You may not read this shell.",
  };

  /**
   * A bridge whose output subscribe never settles, so the pane stays in the state it
   * is in while a question is out.
   */
  function bridgeWithOutputStillOut(): ConsoleBridge {
    const base = paneBridge();
    return {
      ...base,
      growth: {
        ...base.growth,
        terminalSubscribeOutput: () => new Promise(() => undefined),
      },
    };
  }

  /** Mount the pane and hand back the re-render that swaps its bridge. */
  function renderReboundPane(first: ConsoleBridge): {
    readonly region: () => HTMLElement;
    readonly rebindTo: (next: ConsoleBridge) => void;
  } {
    const store = storeThrough(1);
    const { container, rerender } = render(
      <TerminalPane paneId="pane-terminal" bridge={first} sessionStore={store} />,
    );
    const region = (): HTMLElement => paneRegionOf(container);
    return {
      region,
      rebindTo: (next) => {
        rerender(<TerminalPane paneId="pane-terminal" bridge={next} sessionStore={store} />);
      },
    };
  }

  it("asks again on a rebind rather than holding the previous shell's refusal", async () => {
    const { region, rebindTo } = renderReboundPane(bridgeRejectingOutputWith(PERMISSION_DENIED));
    await waitFor(() => {
      expect(outputRefusal(region())).not.toBeNull();
    });

    rebindTo(bridgeWithOutputStillOut());

    expect(outputRefusal(region())).toBeNull();
    expect(region().textContent).toContain("Asking for the output stream");
  });

  it("asks again when the pane is bound to a different shell", async () => {
    // The other half of the subject. A session store swap changes which shell the
    // pane addresses — the session id IS the terminal's identity here — so the
    // previous shell's refusal is a statement about a machine this pane has left.
    const rejecting = bridgeRejectingOutputWith(PERMISSION_DENIED);
    const first = storeThrough(1);
    const { container, rerender } = render(
      <TerminalPane paneId="pane-terminal" bridge={rejecting} sessionStore={first} />,
    );
    const region = (): HTMLElement => paneRegionOf(container);
    await waitFor(() => {
      expect(outputRefusal(region())).not.toBeNull();
    });

    const second = new SessionStore({ sessionId: "session-another-shell" });
    second.initialise({ cursor: 0, entities: [], participantJoinLog: [] });
    rerender(<TerminalPane paneId="pane-terminal" bridge={rejecting} sessionStore={second} />);

    expect(outputRefusal(region())).toBeNull();
    expect(region().textContent).toContain("Asking for the output stream");
  });

  it("negative control: a re-render that keeps the bridge keeps the refusal", async () => {
    // Without it both cases above would pass against a pane that reverted to asking
    // on every render — which is a shell whose refusal nobody could ever read.
    const rejecting = bridgeRejectingOutputWith(PERMISSION_DENIED);
    const { region, rebindTo } = renderReboundPane(rejecting);
    await waitFor(() => {
      expect(outputRefusal(region())).not.toBeNull();
    });

    rebindTo(rejecting);

    expect(outputRefusal(region())?.textContent).toContain("You may not read this shell.");
  });
});
