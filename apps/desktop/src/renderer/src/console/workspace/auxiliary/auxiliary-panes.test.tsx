// This hook RESOLVES a hand-off; it no longer owns one.
//
// THE DEFECT THE SEAM MOVED FOR. The hand-off used to be constructed here, in a cell
// held for the surface's mount — and `ledger/index.ts` keys the workspace on the
// route's session inside a surface `frame/composition/RouteSurface.tsx` keys on the whole address,
// so leaving a session unmounted it. The shell kept the auxiliary windows open,
// because they are the shell's and nobody asked it to close them, and the deck came
// back with an empty detached set: the pane drew its body here while its own window
// was drawing the same pane there.
//
// SO WHAT THESE CASES ASSERT IS RESOLUTION AND KEYING, and neither is a fact about
// what a hand-off DOES. The record's lifetime is `aux-handoff-registry.test.ts`', the
// binding's subject is `DetachedPaneBinding.test.tsx`', and the person-facing round
// trip — navigate away with a pane in a window and come back to it — is
// `Workspace.auxiliary.test.tsx`'. Here: that the hook reaches the window's registry
// rather than minting anything, and that the hand-off it gets back is the one that
// session's own deck wrote.

import { act, render, renderHook } from "@testing-library/react";
import { useEffect, type ReactNode } from "react";
import { describe, expect, it } from "vitest";

import { createFixtureBridge, type ConsoleBridge } from "../../bridge/index.js";
import { FLAGSHIP_SCENARIO } from "../../bridge/scenario/flagship/flagship.js";
import { CommittedFrameRecorder } from "../../core/committed-frame.test-support.js";
import { ConsoleRefusalError } from "../../core/index.js";
import { settle } from "../../core/settle.test-support.js";
import { type FrameBindingContext } from "../../seats/index.js";
import { FrameStore, SessionStoreRegistry } from "../../store/index.js";
import { type DeckPane } from "../deck/model/deck-model.js";
import { DetachedPaneBinding } from "./DetachedPaneBinding.js";
import { servingPort } from "./aux-handoff.test-support.js";
import { useAuxiliaryPanes, type AuxiliaryPaneWiring } from "./auxiliary-panes.js";

/**
 * A stable sink, so the identity these cases read is the hand-off's and not the
 * caller's: the acts are memoised on the hand-off AND on this callback, and an arrow
 * minted per render would change on every pass whatever the seam did.
 */
const IGNORE_REFUSAL = (): void => undefined;

const SESSION_ID = FLAGSHIP_SCENARIO.sessionId;
const OTHER_SESSION_ID = "session-elsewhere";

/**
 * The window a binding is mounted in: one bridge, one frame store, one registry.
 *
 * Built once per case rather than per render, because the binding's subject IS the
 * bridge — a fresh one per pass would retire the registry on every render and hide
 * exactly the keying these cases are about.
 */
function windowContext(): FrameBindingContext {
  return {
    // The plane is stated rather than taken off the fixture: a browser-mode run has no
    // shell behind it, so the fixture's own arm answers `shell-absent` and nothing
    // could be detached at all.
    bridge: {
      ...createFixtureBridge({ scenario: FLAGSHIP_SCENARIO }),
      auxiliaryWindows: servingPort(),
    } satisfies ConsoleBridge,
    frameStore: new FrameStore(),
    // The REAL registry rather than a stub, on `SettingsSurface.test-support.tsx`'
    // rule: this binding reads neither member, and a hand-built pair would let a case
    // assert against a context shape no frame ever hands over.
    sessionStoreRegistry: new SessionStoreRegistry({ read: () => Promise.resolve(undefined) }),
  };
}

/** Render the hook inside a window's binding, addressing one session at a time. */
function renderUnderTheBinding(): ReturnType<
  typeof renderHook<AuxiliaryPaneWiring, { readonly sessionId: string }>
> {
  const context = windowContext();
  return renderHook(
    (props: { readonly sessionId: string }) =>
      useAuxiliaryPanes({ sessionId: props.sessionId, onRefused: IGNORE_REFUSAL }),
    {
      initialProps: { sessionId: SESSION_ID },
      // The binding stands across every rerender below, which is what makes a
      // `sessionId` change a navigation as far as this seam is concerned.
      wrapper: ({ children }: { readonly children: ReactNode }) => (
        <DetachedPaneBinding context={context}>{children}</DetachedPaneBinding>
      ),
    },
  );
}

describe("useAuxiliaryPanes — the hand-off comes from the window", () => {
  it("refuses to run where no composition mounted the binding", () => {
    // The wiring defect stated as a refusal rather than papered over: a hook that
    // minted its own registry here would work perfectly until somebody navigated,
    // which is the state this whole seam exists to remove.
    expect(() =>
      renderHook(() => useAuxiliaryPanes({ sessionId: SESSION_ID, onRefused: IGNORE_REFUSAL })),
    ).toThrow(ConsoleRefusalError);
  });

  it("hands one session the same hand-off across renders", () => {
    // The acts are memoised on the hand-off, so a seam that resolved a fresh one per
    // pass would hand back a new function every render — a subscription opened and
    // abandoned on each one.
    const { result, rerender } = renderUnderTheBinding();
    const detachUnderSession = result.current.openInWindow;

    rerender({ sessionId: SESSION_ID });

    expect(result.current.openInWindow).toBe(detachUnderSession);
  });

  it("gives a session its own detached record back after the surface went elsewhere", async () => {
    // The keying, both halves in one case. Another session's deck must not read this
    // session's windows — a deck mints `pane-N` per layout, so both hold a `pane-1` —
    // and coming back must not start a rival record that knows about none of them.
    const { result, rerender } = renderUnderTheBinding();
    act(() => {
      result.current.openInWindow(deckPaneNamed("pane-1"));
    });
    await settle();
    expect(result.current.paneIds).toStrictEqual(["pane-1"]);

    rerender({ sessionId: OTHER_SESSION_ID });
    // The other session's own record, which is empty — and NOT this session's, which
    // would suppress a body that session's deck has every right to draw.
    expect(result.current.paneIds).toStrictEqual([]);

    rerender({ sessionId: SESSION_ID });

    expect(result.current.paneIds).toStrictEqual(["pane-1"]);
  });
});

describe("useAuxiliaryPanes — the first committed frame", () => {
  it("already names a retained detached pane, before any effect runs", async () => {
    // THE DEFECT IS ONE COMMITTED FRAME LONG. The registry survives a navigation, so a
    // workspace remounting for a session that already has a pane in a window of its own
    // is reading a record that is ALREADY there — and a projection seeded empty and
    // corrected by a passive effect paints that pane's body in the deck for one frame
    // while its own auxiliary window is drawing the same pane. Asserting after the
    // rerender cannot see it: `act` flushes the effect before returning.
    const context = windowContext();
    const committedFrames: string[] = [];
    const readWirings: AuxiliaryPaneWiring[] = [];
    const treeWith = (isProbeMounted: boolean): React.JSX.Element => (
      <DetachedPaneBinding context={context}>
        <CommittedFrameRecorder
          id="auxiliary-panes"
          onFrame={(committedText) => committedFrames.push(committedText)}
        >
          {isProbeMounted ? (
            <DetachedPaneProbe onWiring={(wiring) => readWirings.push(wiring)} />
          ) : null}
        </CommittedFrameRecorder>
      </DetachedPaneBinding>
    );
    const mounted = render(treeWith(true));
    act(() => {
      readWirings[0]?.openInWindow(deckPaneNamed("pane-1"));
    });
    await settle();

    // Away and back, with the window's registry — and the shell's window — standing
    // across both: this is a surface being unmounted by a navigation, not a new window.
    mounted.rerender(treeWith(false));
    committedFrames.length = 0;
    mounted.rerender(treeWith(true));

    expect(committedFrames[0]).toContain("pane-1");
  });
});

/**
 * One reader of the wiring, rendering the pane ids it was handed.
 *
 * A PRIVATE PROBE rather than a shared harness: it exists to put the projection where
 * the frame recorder can read it, and nothing outside this file has a use for a
 * component that renders a list of ids.
 */
function DetachedPaneProbe(props: {
  readonly onWiring: (wiring: AuxiliaryPaneWiring) => void;
}): React.JSX.Element {
  const { onWiring } = props;
  const wiring = useAuxiliaryPanes({ sessionId: SESSION_ID, onRefused: IGNORE_REFUSAL });
  useEffect(() => {
    onWiring(wiring);
  }, [onWiring, wiring]);
  return <span>{wiring.paneIds.join(" ")}</span>;
}

/** One deck pane, in the shape `DeckLayout` publishes them. */
function deckPaneNamed(paneId: string): DeckPane {
  return {
    paneId,
    kind: "timeline",
    entity: undefined,
    sizePermille: 1000,
    isEphemeral: false,
    sourcePaneId: undefined,
  };
}
