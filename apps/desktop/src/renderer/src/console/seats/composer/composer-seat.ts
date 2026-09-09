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
import { type FrameStore, type SessionStore } from "../../store/index.js";
import { type DraftStore } from "../../persistence/index.js";
import { type ConsoleRoute } from "../../routing/index.js";
import { type ConsolePaneAddress } from "../pane/index.js";
import { SingleSlotSeat } from "../slots/index.js";

/** What the workspace hands the composer on every render. */
export interface ComposerSeatProps {
  /** The session the composer is addressed within. */
  readonly sessionStore: SessionStore;
  readonly bridge: ConsoleBridge;
  /**
   * The window store the composer hands a whole-workspace refusal to.
   *
   * The composer is window chrome and its Send reaches a wire, so it is one of the
   * surfaces that can learn the session is gone — and rule 9 puts that code across
   * the frame rather than under one control. It has no other way to reach the frame:
   * a pane is handed one on its context, and the composer is mounted by the seat.
   *
   * Required and carrying no default, on `sessionStore`'s own reading: a mount that
   * forgot it and a mount that meant no escalation read identically as an optional
   * member, and only one of those is a decision.
   */
  readonly frameStore: FrameStore;
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
  /**
   * The same pane as a HANDLE, for the acts that address a pane rather than a target.
   *
   * `focusedPane` is an address — a kind and, where the kind takes one, an entity —
   * and that is what a send is routed by. A `+` menu row contributed by a view family
   * addresses the PANE itself (`browserCapture({ paneId })`), and an address cannot be
   * turned into a handle: two browser panes over two pages share one address.
   *
   * Optional rather than `| undefined` and required, which is the one place this
   * interface departs from its own rule, and deliberately: a composer mounted outside
   * a deck — an auxiliary window, a harness — has no focused pane at all, so an
   * omitted member and a supplied `undefined` are the same fact rather than the
   * forgotten-versus-decided pair that rule exists to keep apart.
   */
  readonly focusedPaneId?: string | undefined;
}

// Consumed by T-023p-1C-2, T-023p-1C-3
/** The composer body. Returns `React.ReactNode` so the mount can render it directly. */
export type ComposerSeatRenderer = (props: ComposerSeatProps) => React.ReactNode;

const composerSeat = new SingleSlotSeat<ComposerSeatRenderer>(
  "composer",
  "the session view mounts one composer; a second owner would make which one renders depend on import order",
);

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

/** The composer body, or `undefined` while the seat is empty. */
export function composerSeatRenderer(): ComposerSeatRenderer | undefined {
  return composerSeat.renderer();
}
