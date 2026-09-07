// One pane context, for every suite in this family that mounts a pane.
//
// A pane body is handed its address and eight bindings, and reads two or three of
// them. The rest is scaffolding every mounting suite has to produce anyway, and four
// suites had each produced their own — four `paneContext` functions, identical but
// for the address arm, drifting on the members nobody was looking at. Two built their
// UI-state store over a `MemoryPersistenceAdapter` and two over an adapter that never
// settles, and the difference recorded nothing: NO PANE IN THIS FAMILY READS
// `uiStateStore` at all. So the four collapse to one, and the never-settling adapter
// is what it carries — the deliberate half of that split. A pane that grew a UI-state
// read would hang here and be found, where the settling stub would have answered it
// with an empty store and passed.
//
// THE ADDRESS IS THE PARAMETER, and the bindings are the rest. That split is the
// address union's own: `seats/pane-address.ts` makes a session-scoped kind carry no
// `entity` member, an entity-keyed kind require one, and an entity-optional kind
// admit either — three shapes a caller states and a helper cannot guess. Passing the
// address through as written keeps that refusal at the call site: an `inspector`
// mounted with no entity, or a `runs` pane handed one, fails to compile here rather
// than being invented for by a default.
//
// AND IT LIVES IN `seats/` because the suites that mount a pane are in three VIEW
// families — runs, approvals, inspector — and a sibling may not import a sibling.
// `console-view-family-isolation` says where a contract three siblings share
// belongs, and this is the contract `seats/pane-registry.ts` declares: a builder for
// `ConsolePaneContext` beside the type it builds.

import { type ConsoleBridge } from "../bridge/index.js";
import { MAXIMUM_LIVE_DRAFT_COUNT } from "../core/index.js";
import { DraftStore, UiStateStore } from "../persistence/index.js";
import { type ConsolePaneAddress } from "./pane-address.js";
import { type PaneKind } from "./pane-kinds.js";
import { type ConsolePaneContext } from "./pane-context.js";
import { FrameStore, type SessionStore } from "../store/index.js";

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
}

/**
 * The context a pane body is mounted with, over one address.
 *
 * The pane id is derived from the kind rather than passed: all four suites named
 * theirs `pane-<kind>`, and a deck's real ids are per-pane values no case here
 * asserts on.
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
    paneId: `pane-${address.kind}`,
    linkedSourcePaneId: bindings.linkedSourcePaneId,
    bridge: bindings.bridge,
    frameStore: new FrameStore(),
    sessionStore: bindings.sessionStore,
    // An adapter that never settles: no pane in this family performs a UI-state read,
    // so one that grew one hangs here rather than passing against a stub.
    uiStateStore: new UiStateStore({ adapter: new Promise(() => undefined) }),
    draftStore: new DraftStore({ maximumDraftCount: MAXIMUM_LIVE_DRAFT_COUNT }),
    focusHue: undefined,
  };
}
