// What the pane harness mounts, worked out apart from the markup: each instance's React key and
// the context its body reads. Both are testable without a DOM. It takes a `PaneDescriptor` and
// never a pane component, so the harness measures what the pane layout would mount.

import type { PaneAddress } from "@renderer/routing/panes/pane-address.js";
import type { PaneContext } from "@renderer/registries/panes/pane-context.js";
import type { PaneDescriptor } from "@renderer/registries/panes/pane-registry.js";
import type { ScreenContext } from "@renderer/registries/screens/screen-context.js";

/** One mounted pane: its key, the registered body, and what that body is handed. */
export interface PaneHarnessInstance {
  /** React's reconciliation identity for this instance. */
  readonly key: string;
  /** The registered body, named so the caller's element reads as a component. */
  readonly PaneBody: PaneDescriptor["render"];
  readonly context: PaneContext;
}

/**
 * One instance's identity in this harness.
 *
 * Stable across a count change, so opening a second instance adds one without rebuilding the
 * first; the budget's per-instance slope depends on that. The session is part of the id so two
 * addresses that differ only in session never reconcile into one pane.
 */
export function paneInstanceId(
  address: PaneAddress,
  sessionId: string,
  instanceIndex: number,
): string {
  return `pane-harness-${address.kind}-${sessionId}-${String(instanceIndex)}`;
}

/**
 * What a pane body is handed here.
 *
 * The bridge and the frame, session, UI-state and draft stores come off the screen context, as
 * they would from a pane layout, so the pane runs in a real app. Nothing opened the pane
 * from another pane, so `linkedSourcePaneId` is `undefined`.
 */
export function paneContextFor(
  context: ScreenContext,
  address: PaneAddress,
  sessionId: string,
  instanceIndex: number,
): PaneContext {
  return {
    ...address,
    paneId: paneInstanceId(address, sessionId, instanceIndex),
    bridge: context.bridge,
    frameStore: context.frameStore,
    sessionStore: context.sessionStore,
    uiStateStore: context.uiStateStore,
    draftStore: context.draftStore,
    linkedSourcePaneId: undefined,
  };
}

/** The `openInstanceCount` instances of one registered kind, in mount order. */
export function paneHarnessInstances(
  descriptor: PaneDescriptor,
  context: ScreenContext,
  address: PaneAddress,
  sessionId: string,
  openInstanceCount: number,
): readonly PaneHarnessInstance[] {
  return Array.from({ length: openInstanceCount }, (_unused, instanceIndex) => ({
    key: paneInstanceId(address, sessionId, instanceIndex),
    PaneBody: descriptor.render,
    context: paneContextFor(context, address, sessionId, instanceIndex),
  }));
}
