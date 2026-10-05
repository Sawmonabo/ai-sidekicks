// The session screen mounts the composer and the composer feature fills it; neither imports
// the other. An empty registry renders nothing. The props are a typed contract because the send
// router needs the addressed target and run state from the session store and the route.

import { type PlatformBridge } from "#renderer/services/platform/platform-bridge.js";
import { type WindowStore } from "#renderer/store/window/window-store.js";
import { type SessionStore } from "#renderer/store/session/session-store.js";
import { type DraftStore } from "#renderer/store/draft-store.js";
import { type AppRoute } from "#renderer/routing/routes.js";
import { type PaneAddress } from "#renderer/routing/panes/pane-address.js";
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

const composerRegistry = new SingleEntryRegistry<ComposerRenderer>(
  "composer",
  "the session view mounts one composer; a second owner " +
    "would make which one renders depend on import order",
);

/** Fills the registry. A second owner is refused; the same owner replaces its body. */
export function registerComposer(owner: string, render: ComposerRenderer): void {
  composerRegistry.register({ owner, render });
}

/** The composer body, or `undefined` while the registry is empty. */
export function findComposerRenderer(): ComposerRenderer | undefined {
  return composerRegistry.renderer();
}
