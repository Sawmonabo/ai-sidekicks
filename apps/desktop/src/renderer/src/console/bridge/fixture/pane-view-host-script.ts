// The scripted view host the fixture hands a pane, declared where the fixture can
// reach it.
//
// IT SITS IN `fixture/` BECAUSE IT EXISTS SO THE FIXTURE CAN ANSWER, and `bridge/`'s
// contract module reaches it by this specifier rather than through `fixture/index.ts`:
// the door is an edge to every module it re-exports, `fixture-bridge.ts` imports the
// contract, and taking that door from the contract would close the cycle `no-circular`
// fails. The deep specifier is the remedy for exactly that one edge.
//
// `Spec-023 §Console Design (Meridian)` 12.11 puts a scripted host under fixture and
// end-to-end runs, the real view where a window exists, and an unavailable host
// otherwise. The wiring table itself is `browser/geometry/view-host.ts`'s — that is the family
// that owns the rectangle, the sample, and the refusal vocabulary a pane renders —
// and this module is the half of the seam the BRIDGE can hold.
//
// WHY THE SEAM IS SPLIT HERE RATHER THAN DECLARED ONCE UP THERE. The console's
// families form a DAG and `bridge/` sits below every view family, so nothing in this
// directory can name a `PaneGeometrySample`. What the fixture actually decides is not
// the rectangle at all — it is whether the pane it is asked about is still
// addressable, and what to say when it is not. That question needs no geometry, so it
// is the part that lives down here, and the view family wraps it into the host it
// publishes through. Nothing is declared twice: the sample never crosses, and the
// refusal code stays in the one module that enumerates it.
//
// WHY THE FIXTURE HOLDS EVERY PANE IT IS ASKED ABOUT. A scenario is a log of session
// events, and the browser namespace is unregistered — `Plan-023 §Console growth slate`
// row `browser-pane-namespace` — so no beat names a page, a view, or a pane's
// destruction. Scripting a refusal here would be inventing a fact no wire carries;
// what the fixture can honestly say is that the window it is standing in for still
// holds the pane. The refusing arm is not dead: it is the shape a test drives to
// exercise the pane's degraded rendering, and the shape the real host will answer
// with once a main-process view exists.

/** Whether the scripted host still holds a pane, and the sentence when it does not. */
export type ScriptedPaneHolding =
  | { readonly holds: true }
  | { readonly holds: false; readonly detail: string };

/** What a bridge publishes instead of a view: an answer about one pane at a time. */
export interface ScriptedPaneViewHost {
  /** How the host is reached, carried onto the view host for diagnostics. */
  readonly transport: string;
  /** Whether this pane is still addressable by the window this host stands for. */
  holdsPane(paneId: string): ScriptedPaneHolding;
}

/** The transport name a fixture-hosted pane reports. 12.11's own word for it. */
export const SCRIPTED_PANE_VIEW_HOST_TRANSPORT = "scripted";

/**
 * The fixture's host: it holds every pane, and it is built per bridge.
 *
 * A factory rather than a shared frozen object, on `live-bridge.ts`'s reason for
 * minting its served set per window: a module-level instance is a singleton this
 * package's structure rules reject, and the allocation is one small object per
 * bridge.
 */
export function createScriptedPaneViewHost(): ScriptedPaneViewHost {
  return {
    transport: SCRIPTED_PANE_VIEW_HOST_TRANSPORT,
    holdsPane: () => ({ holds: true }),
  };
}
