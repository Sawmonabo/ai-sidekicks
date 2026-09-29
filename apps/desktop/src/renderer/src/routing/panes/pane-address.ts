// Which pane, over which entity — and which entities each pane kind admits.
//
// A pane is a view OF something, and what it is a view of is not free. An
// artifact pane over a run reference has nothing to render; an inspector with
// nothing to inspect has no row to look up. So the address pairs each pane kind
// with only the entity kinds it can serve, and the type and the pane registry refuse
// the rest — otherwise a restored layout row or a card could hand a registered body
// an address it cannot serve, and that body would query a partition that has never
// held the row, rendering as permanently missing.
//
// ONE DECLARATION, TWO HALVES DERIVED FROM IT
//
// `PaneEntityScopeByKind` below is the declaration — the kind-indexed map
// `seats/slots/inline-card-seats.ts` uses for its own three card kinds, at the eleven pane
// kinds. Both halves come off it: the static `ConsolePaneAddress` union that
// makes a mismatch a compile error at a typed call site, and the runtime table
// `pane-address-parse.ts` applies at the boundaries where an address arrives
// untyped — a persisted layout snapshot read back off disk, and a route a person
// can type into the address bar. A union written beside a hand-kept table is two
// closed sets that agree until someone widens one, which is the failure
// `pane-kinds.ts` and `store/entities/entities.ts` each state about their own sets.
//
// THE SECOND HALF IS A SIBLING MODULE and not a second declaration. This file is
// the rows and everything the compiler derives from them; the parse beside it is
// what one untyped boundary is held to, with its own refusal vocabulary and its own
// identifier grammar. It imports the table and the two predicates below and declares
// no row of its own — which is what keeps "two halves of one declaration" true after
// the split, and is why `isEntityOptionalPaneKind` is exported rather than inlined
// there: the narrowing it performs is a fact about the table, and the table is here.
//
// WHERE EACH ROW COMES FROM
//
// Most of them come from one rule: the pane-kind set is closed, and `timeline` is
// session-scoped. The inspector shows the session's checkout — a worktree on a project
// session, a workspace on a chat — and the `diff` pane shows that checkout's changes,
// so both rows admit those two entity kinds and no others. No entity kind without a
// checkout has a record or a change set to draw, so none of them is representable
// here.
//
// The two kinds are declared ONCE, below, and both rows read the list. The row is
// derived from a map that decides EVERY entity kind, so a kind added later fails to
// compile until the question is answered for it. Optionality is never invented:
// `agent-console` takes a no-entity arm because its body renders with no agent named,
// and `workflow-builder` takes one because `routing/routes.ts` opens the workflows
// destination bare — "a definition id written into the address here would be a
// second, unowned locator for something the builder has not defined yet".
//
// A REQUIRED entity is never invented either, and for a sharper reason: an
// optional arm that should have been required costs a caller nothing, while a
// required arm over an entity kind no producer mints is unconstructible. `browser`
// and `terminal` are the pair that proves it — both are driven by a seam that keys
// every one of its operations by the pane's or the lease's own id, so neither has
// a reference to be a view of, and both are session-scoped.
//
// A kind whose scope is `never` is SESSION-scoped and its address carries no
// `entity` member at all, rather than a member that is always `undefined`: the
// two read identically at a call site, and only the first makes "this pane takes
// no entity" a fact the compiler holds.

import { CONSOLE_ENTITY_KINDS, type ConsoleEntityRef } from "@renderer/lib/entity-kinds.js";
import { type PaneKind } from "./pane-kinds.js";

/**
 * One console entity kind, read off the reference the store family exports.
 *
 * Derived rather than imported because `store/index.ts` publishes the REFERENCE
 * and not the kind vocabulary, and derived rather than restated because a second
 * union beside `CONSOLE_ENTITY_KINDS` is the drift `store/entities/entities.ts` names.
 */
type ConsoleEntityKind = ConsoleEntityRef["kind"];

/** A `ConsoleEntityRef` narrowed to the kinds one pane kind admits. */
type ScopedEntityRef<TEntityKind extends ConsoleEntityKind> = ConsoleEntityRef & {
  readonly kind: TEntityKind;
};

/**
 * The entity kinds that own a checkout, which the inspector and the diff pane are both
 * views of: a worktree on a project session, a workspace on a chat.
 */
type CheckoutEntityKind = "workspace" | "worktree";

/**
 * Every entity kind, decided. The exhaustiveness check, and the union's proof.
 *
 * A TOTAL map rather than a list of the admitted kinds: `Record<ConsoleEntityKind,
 * boolean>` means a kind added to `CONSOLE_ENTITY_KINDS` fails to compile here until
 * the checkout question is answered for it, and the two intersected records hold this
 * map and the union above to the SAME set — every union member `true`, every other
 * kind `false` — so the union cannot quietly become narrower or wider than the table
 * the runtime filters with.
 */
const CHECKOUT_ADMITS_ENTITY_KIND = {
  session: false,
  user: false,
  run: false,
  agent: false,
  workspace: true,
  worktree: true,
  artifact: false,
  approval: false,
  question: false,
  "workflow-definition": false,
  "workflow-run": false,
  "browser-page": false,
  repo: false,
} as const satisfies Record<ConsoleEntityKind, boolean> &
  Record<CheckoutEntityKind, true> &
  Record<Exclude<ConsoleEntityKind, CheckoutEntityKind>, false>;

/** The same set as data, filtered from the map so the two halves cannot drift. */
const CHECKOUT_ENTITY_KINDS: readonly CheckoutEntityKind[] = CONSOLE_ENTITY_KINDS.filter(
  (kind): kind is CheckoutEntityKind => CHECKOUT_ADMITS_ENTITY_KIND[kind],
);

/**
 * Which pane, over which entity — the address a pane is opened at.
 *
 * A discriminated union over `kind`, so narrowing on the kind narrows the entity
 * with it: an `artifact` arm's entity is an artifact reference and nothing else,
 * and a `runs` arm has no `entity` member to read. Both halves matter — the
 * first refuses the wrong entity, the second refuses a caller that forgot to
 * resolve one.
 */
export type ConsolePaneAddress = { [K in PaneKind]: ConsolePaneAddressOf<K> }[PaneKind];

/**
 * What each pane kind is a view of. THE declaration.
 *
 * `never` where the pane is session-scoped and takes no entity; `| undefined`
 * where the pane renders without one and its own governing module says so. A
 * kind added to `PANE_KINDS` is a compile error here until its scope is decided,
 * which is the site where a new pane kind needs that decision anyway.
 */
interface PaneEntityScopeByKind {
  /** The session's transcript. */
  readonly timeline: never;
  /** Keyed by the inspected checkout's own kind; there is nothing to inspect without one. */
  readonly inspector: ScopedEntityRef<CheckoutEntityKind>;
  /** The session's runs list. */
  readonly runs: never;
  /** The session's approvals queue. */
  readonly approvals: never;
  /** The changes of the checkout the pane was opened from, so the same kinds. */
  readonly diff: ScopedEntityRef<CheckoutEntityKind>;
  readonly artifact: ScopedEntityRef<"artifact">;
  readonly "workflow-run": ScopedEntityRef<"workflow-run">;
  /** Bare from the workflows destination; over a definition once one is saved. */
  readonly "workflow-builder": ScopedEntityRef<"workflow-definition"> | undefined;
  /**
   * One page per browser pane, keyed by the pane's own id and nothing else.
   *
   * Session-scoped rather than over a page reference, because the identity a page
   * reference would name does not exist: every browser operation takes the `paneId`,
   * and the navigation state a page streams back carries a url, a title, and three
   * flags and no page identifier at all. Nothing in this build produces such an
   * entity, so requiring one would make every caller mint an identifier the seam
   * never issues, and would refuse
   * `parseConsolePaneAddress("browser", undefined)` — which is the shape both
   * untyped boundaries actually supply for a pane opened bare.
   */
  readonly browser: never;
  /** One shared terminal per session, over the runtime node's write lease. */
  readonly terminal: never;
  /** Bare is the picker arm: a session is chosen and no agent is named yet. */
  readonly "agent-console": ScopedEntityRef<"agent"> | undefined;
}

/**
 * One pane kind's address arm, entity member and all.
 *
 * THREE SHAPES, NOT TWO. A session-scoped kind has no `entity` member; a kind whose
 * scope is a bare reference REQUIRES one; and a kind whose scope includes `undefined`
 * takes an OPTIONAL one. The third arm used to be written as a required member whose
 * value may be undefined, which is not the same claim: a typed caller could not write
 * the documented bare `{ kind: "workflow-builder" }` at all, while
 * {@link parseConsolePaneAddress} returned exactly that object through a cast — so the
 * static contract and the runtime contract disagreed, and the cast is what hid it.
 *
 * The optional arm keeps `| undefined` in its member type rather than stripping it to
 * `NonNullable`, and that is load-bearing under `exactOptionalPropertyTypes`: without
 * it the only admitted spelling would be the ABSENT key, and every existing caller
 * that writes the equally honest `entity: undefined` would stop compiling. Both
 * spellings mean the same thing here, and both are admitted.
 */
type ConsolePaneAddressOf<TKind extends PaneKind> = [PaneEntityScopeByKind[TKind]] extends [never]
  ? { readonly kind: TKind }
  : EntityRequired<TKind> extends true
    ? { readonly kind: TKind; readonly entity: PaneEntityScopeByKind[TKind] }
    : { readonly kind: TKind; readonly entity?: PaneEntityScopeByKind[TKind] };

/** The entity kinds one pane kind admits, read off the declaration. */
type AdmittedEntityKind<TKind extends PaneKind> = NonNullable<PaneEntityScopeByKind[TKind]>["kind"];

/**
 * Whether one pane kind must be opened over an entity, read off the declaration.
 *
 * False on both no-entity shapes and for the same reason: a session-scoped kind
 * has no entity to require, and an optional arm is one its own governing module
 * documents. Only a kind whose scope is a bare reference is required.
 */
type EntityRequired<TKind extends PaneKind> = undefined extends PaneEntityScopeByKind[TKind]
  ? false
  : [PaneEntityScopeByKind[TKind]] extends [never]
    ? false
    : true;

/**
 * The same scopes as data, for the boundaries the compiler has no claim over.
 *
 * The annotation is a mapped type over the declaration above rather than a
 * second copy of it, so a row naming an entity kind its arm does not admit — or
 * disagreeing about whether the entity is required — fails to compile here. The
 * one divergence the annotation cannot catch is a row that names FEWER kinds
 * than its arm admits, and that direction is fail-closed: the parse refuses an
 * address the union would have allowed, which surfaces as a named refusal rather
 * than as a body reading the wrong partition.
 */
const PANE_ENTITY_SCOPES: {
  readonly [K in PaneKind]: {
    readonly entityKinds: readonly AdmittedEntityKind<K>[];
    readonly entityRequired: EntityRequired<K>;
  };
} = {
  timeline: { entityKinds: [], entityRequired: false },
  inspector: { entityKinds: CHECKOUT_ENTITY_KINDS, entityRequired: true },
  runs: { entityKinds: [], entityRequired: false },
  approvals: { entityKinds: [], entityRequired: false },
  diff: { entityKinds: CHECKOUT_ENTITY_KINDS, entityRequired: true },
  artifact: { entityKinds: ["artifact"], entityRequired: true },
  "workflow-run": { entityKinds: ["workflow-run"], entityRequired: true },
  "workflow-builder": { entityKinds: ["workflow-definition"], entityRequired: false },
  browser: { entityKinds: [], entityRequired: false },
  terminal: { entityKinds: [], entityRequired: false },
  "agent-console": { entityKinds: ["agent"], entityRequired: false },
};

/** One pane kind's entity scope, as a caller deciding at runtime reads it. */
export interface PaneEntityScopeDeclaration {
  /** The entity kinds this pane may be opened over. Empty means session-scoped. */
  readonly entityKinds: readonly ConsoleEntityKind[];
  /** Whether the pane must be opened over one of them. */
  readonly entityRequired: boolean;
}

/**
 * The pane kinds whose address can be written bare — session-scoped, or entity-optional.
 *
 * Derived from the one declaration rather than listed, so a kind whose scope changes
 * moves between the two sides of this predicate without anybody editing a list.
 */
export type EntityOptionalPaneKind = {
  [K in PaneKind]: EntityRequired<K> extends true ? never : K;
}[PaneKind];

/**
 * How a pane names itself as the pane another was opened FROM.
 *
 * A parameter object rather than a bare second string, so the caller writes what
 * the identifier means at the call site: `openPane(address, { linkedSourcePaneId })`
 * reads as a link and a positional `openPane(address, paneId)` reads as anything at
 * all. `linkedSourcePaneId` is required here — the whole value is optional on the
 * opener, so an absent link is an absent argument rather than a present object
 * carrying `undefined`, and there is exactly one way to say "no link".
 */
export interface ConsolePaneLink {
  readonly linkedSourcePaneId: string;
}

/**
 * The call a card and the palette make to open a pane.
 *
 * A callback handed down by whoever owns the deck, rather than a module-scope
 * function, so a pane opens in the deck that asked for it.
 *
 * The optional `link` is how a pane that opens another says which pane it is: the
 * deck copies it onto the new pane's `ConsolePaneContext.linkedSourcePaneId`.
 * Optional because most opens have no source pane at all — a card and the
 * palette open from a list, not from a pane — and a required member would have both
 * of those inventing a value to pass.
 */
export type ConsolePaneOpener = (address: ConsolePaneAddress, link?: ConsolePaneLink) => void;

// THE OPENER AND ITS LINK LIVE HERE, WITH THE ADDRESS THEY CARRY, and not in
// `pane-registry.ts`. The type is about an ADDRESS, this is the module that declares
// addresses, and nothing here imports a module that could reach back.

/**
 * One pane kind's entity scope, for the callers that decide at runtime — the
 * deck's layout validator and a card's open-pane call.
 *
 * The read door onto the table above, so no caller keeps its own copy of a row.
 */
export function paneEntityScopeFor(kind: PaneKind): PaneEntityScopeDeclaration {
  return PANE_ENTITY_SCOPES[kind];
}

/**
 * Whether this kind's address may be written with no entity.
 *
 * A narrowing predicate rather than a bare boolean read, because it is what lets
 * `pane-address-parse.ts` RETURN the bare address without a cast: the table's `entityRequired` column is
 * annotated `EntityRequired<K>`, so the runtime value and the type it narrows to are
 * the same fact, checked by the compiler at the table rather than asserted here.
 */
export function isEntityOptionalPaneKind(kind: PaneKind): kind is EntityOptionalPaneKind {
  return !PANE_ENTITY_SCOPES[kind].entityRequired;
}
