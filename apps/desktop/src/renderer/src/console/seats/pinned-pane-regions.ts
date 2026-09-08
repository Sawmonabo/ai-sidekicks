// The block region a pane pins above its body, and the seat one family fills it
// through.
//
// `Spec-023 §Console Design (Meridian)` puts one entity in one pane behind a single
// mount door, and `ConsolePaneChrome` draws the frame that door wears: a head, then
// the body a family supplied. What the frame had nowhere to put is a BLOCK a pane
// carries above its body and beneath its head — the head's `actions` slot is a
// single-line control strip that takes icon buttons, and a card with a sentence and a
// route into another pane is not a control.
//
// WHY IT IS A SEAT AND NOT A PROP. The first region to exist is channel-scoped
// workflow progress on the channel-scoped `timeline` pane: the pane belongs to one
// view family and the progress it shows is another family's fold, and
// `apps/desktop/AGENTS.md` fails a view family importing a sibling under
// `console-view-family-isolation`. So the only legal join is a contract in `seats/`,
// which is where "the pane chrome every pane wears" already lives. A prop on the
// chrome would have made every host of every pane the courier for a body it has no
// business knowing about.
//
// KEYED BY PANE KIND, AND THE SET IS NOT WIDENED. `PANE_KINDS` is closed at eleven and
// fixed by that spec section; a region is a thing a pane of an existing kind wears,
// never a twelfth kind. One body per kind, owner-scoped exactly as
// `inline-card-seats.ts` and `sidebar-sections.ts` are: a hot reload re-runs the
// owning family's module and must replace, while two owners on one kind is a conflict
// rather than a swap decided by import order.
//
// AN UNFILLED REGION CONTRIBUTES NO ELEMENT, and that is the chrome's rule as much as
// this module's. A pane whose kind nobody registered, and a registered body that
// decided this pane is not one it has anything to say about, are both a pane with a
// head directly above its body — not an empty box with the region's padding in it.
// The chrome asks this module for a NODE rather than for a descriptor, so the
// distinction is settled once here instead of at every frame.
//
// WHAT THE TIMELINE'S HOST OWES THIS SEAT, stated here because the first region is
// registered for the `timeline` kind and its host is another plan's. Two things reach
// the region and neither is this module's to supply: `channelId` on the chrome, which
// is what scopes a channel-keyed body and whose absence a session-scoped pane is
// correctly reporting; and `openPane` in the `PaneControls` the deck provides around
// the pane, which is what a region's route into another pane is taken through. Until
// the ledger family's timeline pane host supplies both, the first region renders on a
// channel-scoped pane and offers no route — a body that says where its subject lives
// rather than one with a control that could not act.

import { KeyedRegistry } from "../core/index.js";
import { type ConsolePaneOpener } from "./pane-address.js";
import { PANE_KINDS, type PaneKind } from "./pane-kinds.js";

/**
 * The pane scope a region body is handed, and the one host act it may take.
 *
 * The chrome's own address members, forwarded verbatim: which kind of pane this is
 * and which session, channel, and run it is addressed at. A body that needs a bridge
 * reads `useConsoleBridge`, which every console surface renders inside — handing one
 * down here would make this seat a second route to a value the provider already
 * publishes, and a region rendered in an auxiliary window would then be reading the
 * wrong window's bridge.
 *
 * Every address member but `kind` is `| undefined` rather than optional, because the
 * chrome holds them in exactly that shape: an address that names no channel is a pane
 * scoped to a session, and a region keyed on a channel answers by rendering nothing.
 * `openPane` is genuinely OPTIONAL and is the one member that is not an address — it
 * is the host's, read off `pane-controls.ts` and forwarded, so a host with no deck
 * hands over no opener at all rather than one that does nothing.
 */
export interface PinnedPaneRegionContext {
  readonly kind: PaneKind;
  readonly sessionId: string | undefined;
  readonly channelId: string | undefined;
  readonly runId: string | undefined;
  /**
   * How a region body opens a pane, where the pane's host offers the act at all.
   *
   * Handed down rather than imported, on the shape `sidebar-sections.ts` already
   * takes for its own sections: a region rendered in an auxiliary window opens panes
   * in THAT window's deck, and a region that reached for a process-wide opener would
   * put its route into whichever deck happened to be composed last.
   *
   * OPTIONAL, and the absence is a real state rather than a gap to fill in. A pane
   * mounted outside a deck — the auxiliary window `Spec-023 §The surface set` names,
   * a full-width surface with no deck at all — has no pane to open and no host to ask,
   * so a body offers its route only where one arrived. That is the absent-not-disabled
   * rule `pane-controls.ts` states for the head's own controls, applied to the region
   * below it.
   */
  readonly openPane?: ConsolePaneOpener | undefined;
}

/** What a family registers to fill one pane kind's pinned region. */
export interface PinnedPaneRegionDescriptor {
  /** The task or family that owns it, so an unfilled region names someone. */
  readonly owner: string;
  readonly render: (context: PinnedPaneRegionContext) => React.ReactNode;
}

export class PinnedPaneRegionRegistry {
  readonly #descriptorsByKind = new KeyedRegistry<PaneKind, PinnedPaneRegionDescriptor>({
    duplicatePolicy: "owner-scoped",
    describeWhat: "pinned pane region",
    ownerOf: (descriptor) => descriptor.owner,
    duplicateHint: "a pane pins one region above its body",
  });

  /** Claim one pane kind's region. A second claim by a different owner is an error. */
  public register(kind: PaneKind, descriptor: PinnedPaneRegionDescriptor): void {
    this.#descriptorsByKind.register(kind, descriptor);
  }

  public unregister(kind: PaneKind): void {
    this.#descriptorsByKind.unregister(kind);
  }

  public descriptorFor(kind: PaneKind): PinnedPaneRegionDescriptor | undefined {
    return this.#descriptorsByKind.get(kind);
  }

  /**
   * Which pane kinds have a region body, in declaration order.
   *
   * Enumerated over `PANE_KINDS` rather than over the map's own keys, so the order is
   * the spec's order and not insertion order — the same reading `inline-card-seats.ts`
   * and `sidebar-sections.ts` take of their own sets.
   */
  public registeredPaneKinds(): readonly PaneKind[] {
    return PANE_KINDS.filter((kind) => this.#descriptorsByKind.has(kind));
  }

  /**
   * The node one pane pins, or nothing.
   *
   * The door the chrome uses, and the one place the two ways of having nothing to
   * pin are collapsed: no body registered for this kind, and a body that looked at
   * this pane's scope and had nothing to say. Both answer `undefined`, so the frame
   * has one question to ask and one branch to draw.
   */
  public render(context: PinnedPaneRegionContext): React.ReactNode {
    const rendered = this.#descriptorsByKind.get(context.kind)?.render(context);
    // `null` and `false` are what a body returns to mean "not this pane", and both are
    // legal `ReactNode`s that React renders as nothing — so a frame that tested only
    // for `undefined` would wrap them in the region's own box and draw its padding
    // around an empty element. The three are one answer here.
    return rendered === null || rendered === undefined || rendered === false ? undefined : rendered;
  }
}

/** The process-wide board a production composition writes into. */
export const pinnedPaneRegionRegistry: PinnedPaneRegionRegistry = new PinnedPaneRegionRegistry();
