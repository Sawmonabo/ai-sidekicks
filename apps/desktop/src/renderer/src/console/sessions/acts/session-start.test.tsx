// What a Start press does once the create it performs has settled.
//
// Driven through the whole destination rather than against `settleSessionStart`
// directly, because the defect this closes was a MISSING WIRE and not a wrong body:
// the shipped probe created a session from its own mount effect and handed the
// settlement to nobody, so every step below was unreachable from a press however
// correctly it had been written. A case that called the act itself would have passed
// against the tree that had the defect.
//
// The bridge source is `live` in every case here, because the absorbed probe carries
// the fixture guard and renders "the question was not put" on any other — so the
// window this suite drives is the one where a start press reaches a wire, and
// `window.sidekicks` is the surface it reaches it through.

import { act, screen } from "@testing-library/react";
import { describe, expect, it, vi, afterEach } from "vitest";

import { contextWith, renderSurface, settle } from "../session-surface.test-support.js";
import {
  CREATED_SESSION_ID,
  installProbeBridge,
  pressStart,
  uninstallProbeBridge,
} from "./probe-bridge.test-support.js";
import { settleFirstSendAutoPin } from "../../seats/index.js";
import type { ConsoleSurfaceContext, NewSessionControlComponent } from "../../seats/index.js";

/** A create that settles with a session, and the calls it recorded. */
function creatingBridge(): ReturnType<typeof vi.fn> {
  const call = vi.fn().mockResolvedValue({
    sessionId: CREATED_SESSION_ID,
    state: "active",
    memberships: [],
    channels: [],
  });
  installProbeBridge(call);
  return call;
}

/** Mount the destination, press Start, and let the create settle. */
async function startASession(context: ConsoleSurfaceContext): Promise<HTMLElement> {
  const { container } = renderSurface(context);
  await settle();
  pressStart(container);
  await settle();
  return container;
}

describe("a settled start — what the console does with the session it just made", () => {
  afterEach(() => {
    uninstallProbeBridge();
    vi.clearAllMocks();
  });

  it("opens the session's store in this window", async () => {
    // A session this window created is a session this window has open. It matters
    // before the navigation rather than as a consequence of it: the all-sessions list
    // merges the node's directory with the registry's own set, so a create the node
    // has not answered for yet is on screen because the registry holds it.
    creatingBridge();
    const openedSessionIds: string[] = [];

    await startASession(contextWith({ bridgeSource: "live", openedSessionIds }));

    expect(openedSessionIds).toStrictEqual([CREATED_SESSION_ID]);
  });

  it("navigates into the session it created", async () => {
    creatingBridge();
    const navigations: unknown[] = [];

    await startASession(contextWith({ bridgeSource: "live", navigations }));

    expect(navigations).toStrictEqual([{ kind: "workspace", sessionId: CREATED_SESSION_ID }]);
  });

  it("records the four origin markers, so a first send has something to read", async () => {
    // Asserted THROUGH the rule rather than by reading the record back, because what
    // matters is that the stamp answers the question the composer asks: this console
    // is the only party that can report where a session came from, and the switch it
    // reads is resolved live off the destination's own durable binding.
    creatingBridge();
    const context = contextWith({ bridgeSource: "live" });

    await startASession(context);

    expect(settleFirstSendAutoPin(context.bridge, CREATED_SESSION_ID)).toStrictEqual({
      pinned: true,
    });
  });

  it("navigates nowhere and opens nothing when the create refuses", async () => {
    // A create that refused produced no session, so there is nothing to open, nothing
    // to stamp and nowhere to go — and the probe's own refusal is what a person sees.
    installProbeBridge(vi.fn().mockRejectedValue(new Error("session.create refused")));
    const navigations: unknown[] = [];
    const openedSessionIds: string[] = [];

    const container = await startASession(
      contextWith({ bridgeSource: "live", navigations, openedSessionIds }),
    );

    expect(navigations).toStrictEqual([]);
    expect(openedSessionIds).toStrictEqual([]);
    expect(container.textContent).toContain("session.create refused");
  });

  it("stamps nothing a session that was never started here", async () => {
    // The negative control for the stamp: the rule fails closed for every session the
    // console did not author, and the case above must be reading a real record rather
    // than a port that answers `pinned` to anything it is asked.
    creatingBridge();
    const context = contextWith({ bridgeSource: "live" });

    await startASession(context);

    expect(settleFirstSendAutoPin(context.bridge, "a-session-nobody-started")).toStrictEqual({
      pinned: false,
      because: "origin-unreported",
    });
  });

  it("does not open a store through a registry this window has already left", async () => {
    // `open` is the one registry call that raises rather than returning a refusal, so
    // a settlement landing after a bridge replacement would otherwise take the whole
    // act — the stamp and the navigation included — with it.
    creatingBridge();
    const navigations: unknown[] = [];

    await startASession(
      contextWith({ bridgeSource: "live", navigations, isRegistryDisposed: true }),
    );

    expect(navigations).toStrictEqual([{ kind: "workspace", sessionId: CREATED_SESSION_ID }]);
  });
});

/** A composed-draft control that hands over the session its send produced. */
function controlSettlingWith(sessionId: string): NewSessionControlComponent {
  return (props) => (
    <button
      type="button"
      onClick={() => {
        props.onSessionCreated(sessionId);
      }}
    >
      Complete a composed send
    </button>
  );
}

describe("a settled composed send — the destination's half of the same act", () => {
  // The probe is not installed for any case here: the composed draft is
  // console-authored and never reaches `window.sidekicks`, so what is under test is
  // the WIRE — that the control this destination mounts is handed a settlement, and
  // that the settlement is the one the start act performs rather than a second
  // spelling of some of it.

  it("opens the session's store and navigates into it, as a settled start does", async () => {
    const navigations: unknown[] = [];
    const openedSessionIds: string[] = [];
    const context = contextWith({ navigations, openedSessionIds });

    renderSurface(context, { newSessionControl: controlSettlingWith(CREATED_SESSION_ID) });
    await settle();
    await act(() => {
      screen.getByRole("button", { name: "Complete a composed send" }).click();
    });

    expect(openedSessionIds).toStrictEqual([CREATED_SESSION_ID]);
    expect(navigations).toStrictEqual([{ kind: "workspace", sessionId: CREATED_SESSION_ID }]);
    // And the origin markers only this console can assert, read back through the rule
    // that asks for them rather than off the record — the same evidence the probed
    // start is held to, because both are one act.
    expect(settleFirstSendAutoPin(context.bridge, CREATED_SESSION_ID)).toStrictEqual({
      pinned: true,
    });
  });

  it("negative control: a control that settles nothing leaves the session unopened", async () => {
    // Without this the case above would pass over a destination that opened and
    // navigated on its own — on a render, on a mount, on anything but the settlement.
    const navigations: unknown[] = [];
    const openedSessionIds: string[] = [];

    renderSurface(contextWith({ navigations, openedSessionIds }));
    await settle();

    expect(openedSessionIds).toStrictEqual([]);
    expect(navigations).toStrictEqual([]);
  });
});
