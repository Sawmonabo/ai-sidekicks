// Mounting the artifact pane: the address arm a case renders at, the two entities it
// renders about, the context builder, and the three ways a case puts the component on
// screen.
//
// SPLIT FROM `artifact-pane.test-support.ts` ALONG THE LINE THE SUITES ALREADY USE.
// That module answers the question "what does the port serve?" — the fixtures, the
// scripted port, the readers, and the waits they settle through. This one answers "how
// does a case get the component up?", and the two are read by different halves of the
// suite set: the reader suites import only the first.
//
// NO SECOND SESSION AND NO SECOND SERVED ROW. Everything about what is SERVED still
// comes from the module next door, which this one imports — a support module that
// re-declared an id or a manifest would put the mounted suites and the reader suites on
// two different fixtures, which is the drift that collapsed two support files into one
// in the first place.

import { fireEvent, render } from "@testing-library/react";
import { StrictMode, createElement, type ReactElement } from "react";

import type { ConsoleBridge, GrowthAnswer } from "../../bridge/index.js";

// Re-exported so a suite scripting this pane's port names one import rather than two.
// A type alias, so this is not the barrel chain `console-no-barrel-chain` forbids —
// that rule is about a DOOR forwarding another door's symbols, and this module is a
// leaf the suites beside it read.
export type { GrowthAnswer };
import { ManualClock } from "../../core/index.js";
import { LiveAnnouncerProvider } from "../../primitives/index.js";
import { SessionStore } from "../../store/index.js";
import { ArtifactPane, type ArtifactPaneProps } from "./ArtifactPane.js";
import { artifactBridgeAnswering } from "./artifact-pane.test-support.js";

/** This pane's own address arm, taken from the prop rather than restated. */
export type ArtifactPaneContext = ArtifactPaneProps["context"];

export const ARTIFACT_ENTITY = { kind: "artifact", id: "artifact-diff-01" } as const;
export const OTHER_ARTIFACT_ENTITY = { kind: "artifact", id: "artifact-attachment-02" } as const;

/**
 * A pane context on the address the case is about.
 *
 * `legacy-surfaces.test.ts`'s cast, for its reason: the assertions are about what the
 * address renders as. The ADDRESS half is not cast — the entity parameter is the arm's
 * own, so a case handing this pane a subject an artifact pane is never opened over
 * fails to compile here.
 *
 * THE BRIDGE IS ALWAYS PRESENT, and it used to be optional. `ConsolePaneContext`
 * declares it required and the cast hid an `undefined` from the compiler, which was
 * harmless only while nothing read it before a session existed — and stopped being so
 * the moment the pane began resolving its clock off the bridge. A case that scripts no
 * operation gets a port that refuses every one of them, which is what a live bridge
 * answers for these wires anyway.
 */
export function contextFor(
  entity: ArtifactPaneContext["entity"],
  reached: {
    readonly bridge?: ConsoleBridge;
    readonly sessionId?: string;
    /**
     * The exact store to hand over, for a case about the store's IDENTITY.
     *
     * `sessionId` mints a fresh store per call, which is what a case about a
     * reconnect wants and the opposite of what a case about a re-render at an
     * unchanged subject wants. Naming the object says which of the two is meant.
     */
    readonly sessionStore?: SessionStore;
  } = {},
): ArtifactPaneContext {
  return {
    kind: "artifact",
    entity,
    paneId: "pane-artifact-1",
    bridge: reached.bridge ?? artifactBridgeAnswering({}),
    // A REAL store rather than a stub carrying an id: the reader now subscribes to it
    // for three of its four refresh reasons, and a stub with no `readable` would make
    // every case here fail on the subscription rather than on what it asserts.
    sessionStore:
      reached.sessionStore ??
      (reached.sessionId === undefined
        ? undefined
        : new SessionStore({ sessionId: reached.sessionId })),
  } as unknown as ArtifactPaneContext;
}

/** The delete confirm is two steps in place; both are pressed here. */
export function confirmDelete(getByRole: ReturnType<typeof render>["getByRole"]): void {
  fireEvent.click(getByRole("button", { name: "Delete" }));
  fireEvent.click(getByRole("button", { name: "Delete permanently" }));
}

/**
 * The tree the pane is mounted in, as an element a case can re-render.
 *
 * SEPARATE FROM THE MOUNT because a case about the pane's BINDING re-renders at a
 * moved context and `rerender` takes a tree rather than a context — and a second tree
 * written at that call site would be a second answer to what the pane renders under.
 *
 * `createElement` rather than JSX because this module is one home for one role and
 * the role is functions rather than a component — which is what the `.ts` extension
 * says, and what the `.tsx` half this replaced could not say while carrying the same
 * builders under a component's name.
 *
 * The announcer is the pane's environment rather than its dependency, and it runs on
 * a frozen clock so a settlement sentence stands until the case reads it. It is minted
 * per call, so a re-render at a moved context keeps the announcer it opened under only
 * where the case passes the same tree — which no case does, and none should: the
 * announcer holds no reading.
 */
export function paneTree(context: ArtifactPaneContext, announcerClock: ManualClock): ReactElement {
  return createElement(LiveAnnouncerProvider, {
    clock: announcerClock,
    children: createElement(ArtifactPane, { context }),
  });
}

/** Mount the pane inside the announcer it renders under. */
export function renderPane(context: ArtifactPaneContext): ReturnType<typeof render> {
  return render(paneTree(context, new ManualClock()));
}

/**
 * Mount the pane the way React's development double-mount does.
 *
 * `StrictMode` runs every effect's setup, then its cleanup, then its setup again on
 * the same committed value — the sequence that disposes a reader and then calls
 * `start()` on the corpse. A pane that cannot come back from it is inert with nothing
 * on screen to say so, which is why this is a mount of its own rather than a flag.
 */
export function renderPaneStrictly(context: ArtifactPaneContext): ReturnType<typeof render> {
  return render(createElement(StrictMode, null, paneTree(context, new ManualClock())));
}
