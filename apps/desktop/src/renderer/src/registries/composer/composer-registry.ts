// The composer registry: what the session screen hands the message input.
//
// The composer is the shell chrome every session view already contains. Two
// features meet on it: the session screen mounts it under the pane layout, and the
// composer feature fills it. Neither imports the other — the session screen reads
// `findComposerRenderer()` and renders whatever is there, and an empty registry renders
// nothing rather than a placeholder that looks broken.
//
// WHY THE PROPS ARE A CONTRACT AND NOT AN ARGUMENT THE MOUNT INVENTS
//
// The composer's send router "resolves Send to the one wire call the addressed
// target admits", which means it needs the addressed target and the run state
// behind it. Those come from the session store and the route. If the mount and the
// body agreed on that shape by convention rather than by type, the two branches
// would agree until one of them shipped.
import { type PlatformBridge } from "@renderer/services/platform/platform-bridge.js";
import { type WindowStore } from "@renderer/store/window/window-store.js";
import { type SessionStore } from "@renderer/store/session/session-store.js";
import { type DraftStore } from "@renderer/store/draft-store.js";
import { type AppRoute } from "@renderer/routing/routes.js";
import { type PaneAddress } from "@renderer/routing/panes/pane-address.js";
import { SingleEntryRegistry } from "@renderer/lib/single-entry-registry.js";

/** What the session screen hands the composer on every render. */
export interface ComposerProps {
  /** The session the composer is addressed within. */
  readonly sessionStore: SessionStore;
  readonly bridge: PlatformBridge;
  /**
   * The window store the composer hands a refusal for the whole session screen to.
   *
   * The composer is window chrome and its Send reaches a wire, so it is one of the
   * places that can learn the session is gone — and rule 9 puts that code across
   * the frame rather than under one control. It has no other way to reach the frame:
   * a pane is handed one on its context, and the composer is mounted by the session screen.
   *
   * Required and carrying no default, on `sessionStore`'s own reading: a mount that
   * forgot it and a mount that meant no escalation read identically as an optional
   * member, and only one of those is a decision.
   */
  readonly frameStore: WindowStore;
  /**
   * Where the unsent message body lives. Drafts are the draft store's and never
   * the persistence chokepoint's: drafts stay out of durable storage, so the
   * composer is handed this one rather than left to reach for the persistence module
   * and find the wrong chokepoint there.
   */
  readonly draftStore: DraftStore;
  readonly route: AppRoute;
  /**
   * The pane the person is looking at, or `undefined` when focus is not in
   * the pane layout.
   *
   * The composer reads it to address a send — a focused pane over an agent entity
   * is what "the addressed target" means at the moment Send is pressed. It is
   * deliberately the pane's ADDRESS and not its context: the composer has its own
   * bridge and stores, and handing it a second set through another pane's context
   * would be two paths to one wire.
   */
  readonly focusedPane: PaneAddress | undefined;
}

/** The composer body. Returns `React.ReactNode` so the mount can render it directly. */
export type ComposerRenderer = (props: ComposerProps) => React.ReactNode;

const composerRegistry = new SingleEntryRegistry<ComposerRenderer>(
  "composer",
  "the session view mounts one composer; a second owner would make which one renders depend on import order",
);

/** The call the composer feature makes to fill the registry. */
export function registerComposer(owner: string, render: ComposerRenderer): void {
  composerRegistry.register({ owner, render });
}

/**
 * Release the registry.
 *
 * Test scaffolding, and named as such: the registry is module-scope, so a case that
 * fills it would leak into the next one. Nothing in the shipped tree unfills the
 * registry — a feature that registered and then withdrew would leave the session screen
 * rendering nothing with no owner to name.
 */
export function unregisterComposer(): void {
  composerRegistry.unregister();
}

/** The composer body, or `undefined` while the registry is empty. */
export function findComposerRenderer(): ComposerRenderer | undefined {
  return composerRegistry.renderer();
}
