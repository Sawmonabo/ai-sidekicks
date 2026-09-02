// The composer seat: what the workspace hands the message input.
//
// `Spec-023 §Signature Feature Composition Sketches` §The Session Composer calls
// the composer "the shell chrome every session view already contains". Two
// families meet on it: the workspace (T-023p-1C-2) mounts it under the deck, and
// the composer family (T-023p-1C-3) fills it. Neither imports the other — the
// workspace reads `composerSeatRenderer()` and renders whatever is there, and an
// empty seat renders nothing rather than a placeholder that looks broken.
//
// WHY THE PROPS ARE A CONTRACT AND NOT AN ARGUMENT THE MOUNT INVENTS
//
// The composer's send router "resolves Send to the one wire call the addressed
// target admits", which means it needs the addressed target and the run state
// behind it. Those come from the session store and the route. If the mount and the
// body agreed on that shape by convention rather than by type, the two branches
// would agree until one of them shipped.

import { type ConsoleBridge } from "../../bridge/index.js";
import { type SessionStore } from "../../store/index.js";
import { type DraftStore } from "../../persistence/index.js";
import { type ConsoleRoute } from "../../routing/index.js";
import { type ConsolePaneAddress } from "./pane-address.js";
import { SingleSlotSeat } from "./single-slot-seat.js";

// Consumed by T-023p-1C-2, T-023p-1C-3
/** What the workspace hands the composer on every render. */
export interface ComposerSeatProps {
  /** The session the composer is addressed within. */
  readonly sessionStore: SessionStore;
  readonly bridge: ConsoleBridge;
  /**
   * Where the unsent message body lives. Drafts are the draft store's and never
   * the persistence chokepoint's: `Spec-023 §Console Design (Meridian)` keeps
   * drafts out of durable storage, so the composer is handed this one rather than
   * left to reach for the persistence door and find the wrong chokepoint there.
   */
  readonly draftStore: DraftStore;
  readonly route: ConsoleRoute;
  /**
   * The deck pane the person is looking at, or `undefined` when focus is not in
   * the deck.
   *
   * The composer reads it to address a send — a focused pane over an agent entity
   * is what "the addressed target" means at the moment Send is pressed. It is
   * deliberately the pane's ADDRESS and not its context: the composer has its own
   * bridge and stores, and handing it a second set through another pane's context
   * would be two paths to one wire.
   */
  readonly focusedPane: ConsolePaneAddress | undefined;
}

// Consumed by T-023p-1C-2, T-023p-1C-3
/** The composer body. Returns `React.ReactNode` so the mount can render it directly. */
export type ComposerSeatRenderer = (props: ComposerSeatProps) => React.ReactNode;

const composerSeat = new SingleSlotSeat<ComposerSeatRenderer>(
  "composer",
  "the session view mounts one composer; a second owner would make which one renders depend on import order",
);

// Consumed by T-023p-1C-3
/** The call the composer family makes to fill the seat. */
export function registerComposerSeat(owner: string, render: ComposerSeatRenderer): void {
  composerSeat.register({ owner, render });
}

// Consumed by T-023p-1C-2, T-023p-1C-3
/**
 * Release the seat.
 *
 * Test scaffolding, and named as such: the seat is module-scope, so a case that
 * fills it would leak into the next one. Nothing in the shipped tree unfills a
 * seat — a family that registered and then withdrew would leave the workspace
 * rendering nothing with no owner to name.
 */
export function unregisterComposerSeat(): void {
  composerSeat.unregister();
}

// Consumed by T-023p-1C-2
/** The composer body, or `undefined` while the seat is empty. */
export function composerSeatRenderer(): ComposerSeatRenderer | undefined {
  return composerSeat.renderer();
}
