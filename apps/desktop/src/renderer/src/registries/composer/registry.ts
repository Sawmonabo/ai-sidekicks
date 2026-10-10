// The session screen mounts the composer and the composer feature fills it; neither imports
// the other. An empty registry renders nothing. The props are a typed contract because the send
// router needs the addressed target and run state from the session store and the route. Until the
// session's store opens, the screen mounts the composer's resting space instead, which needs no
// session, so the conversation above it is already at the height it keeps.

import { type PlatformBridge } from "#renderer/services/platform/bridge.js";
import { type WindowStore } from "#renderer/store/window/store.js";
import { type SessionStore } from "#renderer/store/session/store.js";
import { type DraftStore } from "#renderer/store/drafts.js";
import { type AppRoute } from "#renderer/routing/routes.js";
import { type PaneAddress } from "#renderer/routing/panes/address.js";
import { SingleEntryRegistry } from "#renderer/lib/single-entry-registry.js";

/** What the session screen hands the composer on every render. */
export interface ComposerProps {
  /** The session the composer is addressed within. */
  readonly sessionStore: SessionStore;
  readonly bridge: PlatformBridge;
  /**
   * The window store a refusal that changes what the whole session can do (the session is gone)
   * is escalated to, so it is drawn across the frame rather than under one control. Required,
   * so a mount that forgot it cannot be mistaken for one that meant no escalation.
   */
  readonly frameStore: WindowStore;
  /** Where the unsent message body lives; drafts stay out of durable storage. */
  readonly draftStore: DraftStore;
  readonly route: AppRoute;
  /**
   * The focused pane, or `undefined` when focus is outside the pane layout. A focused pane over
   * an agent entity is the addressed target of a send. It is the address, not the pane's
   * context, because the composer has its own bridge and stores.
   */
  readonly focusedPane: PaneAddress | undefined;
}

/** The composer body; returns a node so the mount can render it directly. */
export type ComposerRenderer = (props: ComposerProps) => React.ReactNode;

/** What the composer feature fills the registry with. */
export interface ComposerRenderers {
  /** The composer over an open session. */
  readonly open: ComposerRenderer;
  /** The box the composer takes at rest with nothing drawn in it, for before the session opens. */
  readonly resting: () => React.ReactNode;
}

const composerRegistry = new SingleEntryRegistry<ComposerRenderers>(
  "composer",
  "the session view mounts one composer; a second owner " +
    "would make which one renders depend on import order",
);

/** Fills the registry. A second owner is refused; the same owner replaces its body. */
export function registerComposer(owner: string, render: ComposerRenderers): void {
  composerRegistry.register({ owner, render });
}

/** The composer's bodies, or `undefined` while the registry is empty. */
export function findComposerRenderers(): ComposerRenderers | undefined {
  return composerRegistry.renderer();
}
