// One pane context, for every suite in any family that mounts a pane.
//
// A pane body is handed its address and eight bindings, and reads two or three of
// them. The rest is scaffolding every mounting suite has to produce anyway, and the
// suites had each produced their own — `paneContext` functions identical but for the
// address arm, drifting on the members nobody was looking at. Some built their
// UI-state store over a settling adapter and some over one that never settles, and
// the difference recorded nothing: NO PANE THAT MOUNTS THROUGH THIS BUILDER READS
// `uiStateStore` at all. So they collapse to one, and the never-settling adapter is
// the DEFAULT it carries — the deliberate half of that split. A pane that grew a
// UI-state read hangs here and is found, where a settling stub would have answered
// it with an empty store and passed. A suite that genuinely needs a store which
// ANSWERS hands one in, at the call site, rather than writing a second builder to
// get it: that binding is what turned every hand-written copy into a silent fork.
//
// THE ADDRESS IS THE PARAMETER, and the bindings are the rest. That split is the
// address union's own: `seats/pane-address.ts` makes a session-scoped kind carry no
// `entity` member, an entity-keyed kind require one, and an entity-optional kind
// admit either — three shapes a caller states and a helper cannot guess. Passing the
// address through as written keeps that refusal at the call site: an `inspector`
// mounted with no entity, or a `runs` pane handed one, fails to compile here rather
// than being invented for by a default.
//
// AND IT LIVES IN `seats/` because the suites that mount a pane are in VIEW families
// — runs, approvals, inspector, browser, terminal — and a sibling may not import a
// sibling. `console-view-family-isolation` says where a contract those siblings
// share belongs, and this is the contract `seats/pane-registry.ts` declares: a
// builder for `ConsolePaneContext` beside the type it builds.

import { type ConsoleBridge } from "../../bridge/index.js";
import { MAXIMUM_LIVE_DRAFT_COUNT } from "../../core/index.js";
import { DraftStore, UiStateStore } from "../../persistence/index.js";
import { type ConsolePaneAddress } from "./pane-address.js";
import { type PaneKind } from "./pane-kinds.js";
import { type ConsolePaneContext } from "./pane-context.js";
import { FrameStore, type SessionStore } from "../../store/index.js";

/** One pane kind's address arm, as the caller writes it. */
type PaneAddressOf<TKind extends PaneKind> = Extract<ConsolePaneAddress, { readonly kind: TKind }>;

/**
 * The binding half of a pane context — everything that is not the address.
 *
 * `Omit` over the whole union rather than over one arm, and that is the load-bearing
 * choice: `keyof` a union is the members every arm carries, so `entity` — which only
 * some arms have — drops out on its own and what remains is exactly the eight members
 * every pane is bound with. Naming an arm here would have made one pane kind's shape
 * the definition of every other one's.
 */
type PaneBindingMembers = Omit<ConsolePaneContext, "kind">;

/**
 * What a mounting suite actually decides.
 *
 * `bridge` and `sessionStore` are required and carry no default, because they are the
 * bindings a pane actually reads: a default for either would be a fixture chosen by
 * this module for a case it cannot see. `sessionStore` is required-carrying-undefined
 * on the context's own precedent — a bare route and a forgotten argument read
 * identically as an optional member, and only one of them is a claim.
 */
export interface PaneBindings {
  readonly bridge: ConsoleBridge;
  readonly sessionStore: SessionStore | undefined;
  /** The pane this one was opened FROM, where a case is about the link. */
  readonly linkedSourcePaneId?: string;
  /**
   * The window store the pane escalates into, for a case that reads its banners.
   *
   * Optional and defaulted, unlike the two above: a pane is always given one and a
   * suite that does not assert about the frame has nothing to decide here, so a
   * required member would make every mount name a store it never reads.
   *
   * `| undefined` spelled out beside the `?`, because `exactOptionalPropertyTypes`
   * makes those two different types: a caller that forwards its own optional member
   * passes the property PRESENT and undefined, which the bare `?` rejects.
   */
  readonly frameStore?: FrameStore | undefined;
  /**
   * This pane's identity in the deck, where a case is about WHICH pane it is.
   *
   * Defaulted from the kind, which is what every suite that has nothing to say here
   * wants — and named by the one class of case that does: a deck moves a slot to
   * another pane without remounting, so a suite proving the pane's state says whose
   * it is has to hold two ids at once. That is a claim the caller makes, and the
   * only reason this member exists rather than the derivation alone.
   */
  readonly paneId?: string | undefined;
  /**
   * A UI-state store that ANSWERS, for a case that is about a UI-state read.
   *
   * The default is the never-settling adapter this module's header argues for, and
   * this member is how a suite opts out of it OUT LOUD. Two families had opted out
   * silently, by writing their own builder around `UiStateStore.opening()`, and the
   * cost of that was not the extra function: a pane in either of them could grow a
   * UI-state read, pass against a store that answered empty, and hang in the four
   * families that had kept the adapter — one behaviour with two answers, which is
   * the divergence a second builder always buys.
   */
  readonly uiStateStore?: UiStateStore | undefined;
}

/**
 * The context a pane body is mounted with, over one address.
 *
 * The pane id is DERIVED from the kind unless the caller names one: the suites that
 * do not care named theirs `pane-<kind>`, and a deck's real ids are per-pane values
 * most cases never assert on. The exception is a case whose subject IS the identity,
 * and {@link PaneBindings.paneId} is where it says so.
 *
 * The return is spelled as the intersection rather than as `PaneContextOf<TKind>`,
 * which is the same type at every concrete call: `PaneContextOf` resolves through an
 * `Extract` the compiler will not evaluate while `TKind` is still a parameter, so the
 * annotation it accepts is the one that says what the object literal IS.
 */
export function paneContext<TKind extends PaneKind>(
  address: PaneAddressOf<TKind>,
  bindings: PaneBindings,
): PaneAddressOf<TKind> & PaneBindingMembers {
  return {
    ...address,
    paneId: bindings.paneId ?? `pane-${address.kind}`,
    linkedSourcePaneId: bindings.linkedSourcePaneId,
    bridge: bindings.bridge,
    frameStore: bindings.frameStore ?? new FrameStore(),
    sessionStore: bindings.sessionStore,
    // An adapter that never settles: no pane mounted through this builder performs a
    // UI-state read, so one that grew one hangs here rather than passing against a
    // stub. A suite that needs a store which answers passes it.
    uiStateStore:
      bindings.uiStateStore ?? new UiStateStore({ adapter: new Promise(() => undefined) }),
    draftStore: new DraftStore({ maximumDraftCount: MAXIMUM_LIVE_DRAFT_COUNT }),
    focusHue: undefined,
  };
}
