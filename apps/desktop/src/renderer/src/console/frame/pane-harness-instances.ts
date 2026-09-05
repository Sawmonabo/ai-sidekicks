// What the pane harness mounts, worked out apart from the markup that mounts it.
//
// The harness holds a VARIABLE number of registered pane bodies, and everything that
// varies per instance — the identity React reconciles by, and the context the body
// reads its stores from — is decided here. The surface beside this module maps the
// result to elements and decides nothing.
//
// Held apart for two reasons. The first is the ordinary one: a per-instance identity
// rule and a context-composition rule are both testable without a DOM, and neither
// needs React to state. The second is the rule the harness itself rests on — the
// thing being measured is what the DECK would mount, which is the descriptor a family
// registered, so this module takes `ConsolePaneDescriptor` and never a pane component,
// and a harness that imported one directly would measure a component that happens to
// sit beside the registration.

import type {
  ConsolePaneAddress,
  ConsolePaneContext,
  ConsolePaneDescriptor,
} from "../seats/index.js";
import type { ConsoleSurfaceContext } from "./surface-registry.js";

/** One mounted pane: its key, the registered body, and what that body is handed. */
export interface PaneHarnessInstance {
  /** React's reconciliation identity for this instance. */
  readonly key: string;
  /** The registered body, named so the caller's element reads as a component. */
  readonly PaneBody: ConsolePaneDescriptor["render"];
  readonly context: ConsolePaneContext;
}

/**
 * One instance's identity in this harness.
 *
 * Stable across a count change, which is what makes opening a second instance an
 * ADDITION rather than a re-key that would unmount and rebuild the first — and the
 * per-instance slope the budget's negative control compares depends on the first
 * instance surviving the second one's mount.
 *
 * The SESSION is part of it because the identity has to change when the subject
 * does. Keyed on the kind and the index alone, two addresses differing only in their
 * session produced the same key, so React reconciled the instances rather than
 * rebuilding them and a pane bound to one session went on running against another.
 */
export function paneInstanceId(
  address: ConsolePaneAddress,
  sessionId: string,
  instanceIndex: number,
): string {
  return `pane-harness-${address.kind}-${sessionId}-${String(instanceIndex)}`;
}

/**
 * What a pane body is handed here, and why each member is the surface's own.
 *
 * Every store comes off the surface context rather than being minted here: the
 * budget's subject is a pane in a RUNNING console, so the pane reads the window's
 * own bridge, frame store, session store, durable UI state, and drafts — the same
 * five a deck would hand it. The two members a deck decides and this harness does
 * not are passed absent rather than invented: nothing opened this pane from another
 * pane, and no actor is attributed to it, which is the neutral answer
 * `ConsolePaneContext` documents for both.
 */
export function paneContextFor(
  context: ConsoleSurfaceContext,
  address: ConsolePaneAddress,
  sessionId: string,
  instanceIndex: number,
): ConsolePaneContext {
  return {
    ...address,
    paneId: paneInstanceId(address, sessionId, instanceIndex),
    bridge: context.bridge,
    frameStore: context.frameStore,
    sessionStore: context.sessionStore,
    uiStateStore: context.uiStateStore,
    draftStore: context.draftStore,
    linkedSourcePaneId: undefined,
    focusHue: undefined,
  };
}

/**
 * The `openInstanceCount` instances of one registered kind, in mount order.
 *
 * The count is the only input that changes while the surface is open, and it is read
 * as a floor of zero rather than trusted: a negative count would ask `Array.from` for
 * a negative length, which throws, and a control that had gone one step past its own
 * guard would take the window's error boundary for an arithmetic slip.
 */
export function paneHarnessInstances(
  descriptor: ConsolePaneDescriptor,
  context: ConsoleSurfaceContext,
  address: ConsolePaneAddress,
  sessionId: string,
  openInstanceCount: number,
): readonly PaneHarnessInstance[] {
  return Array.from({ length: Math.max(0, openInstanceCount) }, (_unused, instanceIndex) => ({
    key: paneInstanceId(address, sessionId, instanceIndex),
    PaneBody: descriptor.render,
    context: paneContextFor(context, address, sessionId, instanceIndex),
  }));
}
