// Which pane, over which entity — and which entities each pane kind admits.
//
// A pane is a view OF something, and what it is a view of is not free. An
// artifact pane over a run reference has nothing to render; an inspector with
// nothing to inspect has no row to look up. The address used to pair every pane
// kind with every entity kind or with `undefined`, so both were constructible,
// and neither the type nor the pane registry refused them — a restored layout row
// or a sidebar card could hand a registered body an address it cannot serve, and
// that body would query a partition that has never held the row, rendering as
// permanently missing.
//
// ONE DECLARATION, TWO HALVES DERIVED FROM IT
//
// `PaneEntityScopeByKind` below is the declaration — the kind-indexed map
// `inline-card-seats.ts` uses for its own three card kinds, at the eleven pane
// kinds. Both halves come off it: the static `ConsolePaneAddress` union that
// makes a mismatch a compile error at a typed call site, and the runtime table
// {@link parseConsolePaneAddress} applies at the boundaries where an address
// arrives untyped — a persisted layout snapshot read back off disk, and a route
// a person can type into the address bar. A union written beside a hand-kept
// table is two closed sets that agree until someone widens one, which is the
// failure `pane-kinds.ts` and `store/entities.ts` each state about their own sets.
//
// WHERE EACH ROW COMES FROM
//
// `Spec-023 §Console Design (Meridian)` §The surface set fixes most of them in
// one sentence: the pane-kind set is closed, `timeline` is "(session- or
// channel-scoped)", and "a repo, workspace, worktree, invite, or member entity
// is a card in its sidebar section and opens as an `inspector` pane keyed by its
// entity kind, its changes opening the `diff` pane — no dedicated pane kind exists
// for those families and the set is not widened for them". All five of the entities
// that sentence names are console entity KINDS, so the inspector's row is that
// sentence's list and nothing narrower. It was the intersection with the partition
// set until repo and invite were missing from that set — which made a repo card and
// an invite card unrepresentable at the address layer, and would have had the repos
// and collaboration branches reopen this shared substrate to open a pane the spec
// already routes. The row is now derived from a map that decides EVERY entity kind,
// so a kind added later fails to compile until the question is answered for it.
//
// AND THE `diff` ROW COMES OFF THE SAME CLAUSE OF THE SAME SENTENCE. "its changes
// opening the `diff` pane" has one antecedent — the enumerated subject the clause
// before it also takes — so the two clauses distribute over one list, and reading the
// subject as five kinds for the inspector and as three for the diff would be two
// readings of one sentence. Nothing in that section narrows the second clause, and
// the dash clause that closes it says why both are stated at all: those families get
// no pane kind of their own, so these two are the kinds their cards reuse. The `diff`
// row was `worktree | workspace`, which refused a repo's changes statically and
// answered `pane-entity-kind-mismatch` at the runtime parse — the same defect the
// inspector's row already carried once, one clause later in the same sentence.
//
// So the list is declared ONCE, below, and both rows read it. What an invite's or a
// member's changes RENDER is not settled anywhere in the corpus — the diff wire is
// unregistered (the console growth slate's gitflow row, owned by `Spec-011`) — and it
// belongs to the repos and collaboration families that own those cards, not to an
// address layer that renders nothing. This module's claim is narrower and is the one
// it can make: the address is representable, so those families can answer that
// question without reopening this substrate. Optionality is never
// invented: `agent-console` takes a no-entity arm because
// `src/shared/auxiliary-routes.ts` gives that route a no-context target the
// window's own picker resolves, and `workflow-builder` takes one because
// `routing/routes.ts` opens the workflows destination bare — "a definition id
// written into the address here would be a second, unowned locator for something
// the builder has not defined yet".
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

import { refuse, type ConsoleRefusal } from "../core/index.js";
import { IDENTIFIER_MAX_LENGTH, isSingleNameIdentifierShaped } from "../persistence/index.js";
import { CONSOLE_ENTITY_KINDS, type ConsoleEntityRef } from "../store/index.js";
import { PANE_KINDS, isPaneKind, type PaneKind } from "./pane-kinds.js";

/** The subsystem a pane-address refusal names as its author. */
const PANE_ADDRESS_ORIGIN = "pane-address";

/**
 * The ceiling the entity-id grammar enforces, named for the refusal sentence.
 *
 * Read off the grammar rather than restated, so the number a person is told is the
 * number the predicate applied. It is `persistence/`'s constant because the grammar
 * is `persistence/`'s — this module applies it, it does not own it.
 */
const PANE_ENTITY_ID_MAX_LENGTH = IDENTIFIER_MAX_LENGTH;

/**
 * One console entity kind, read off the reference the store family exports.
 *
 * Derived rather than imported because `store/index.ts` publishes the REFERENCE
 * and not the kind vocabulary, and derived rather than restated because a second
 * union beside `CONSOLE_ENTITY_KINDS` is the drift `store/entities.ts` names.
 */
type ConsoleEntityKind = ConsoleEntityRef["kind"];

/** A `ConsoleEntityRef` narrowed to the kinds one pane kind admits. */
type ScopedEntityRef<TEntityKind extends ConsoleEntityKind> = ConsoleEntityRef & {
  readonly kind: TEntityKind;
};

/**
 * The entity kinds that open as a card in a sidebar section.
 *
 * `Spec-023 §Console Design (Meridian)` §The surface set: "a repo, workspace,
 * worktree, invite, or member entity is a card in its sidebar section and opens as an
 * `inspector` pane keyed by its entity kind, its changes opening the `diff` pane".
 * All five are here — `participant` is that sentence's member — now that the console's
 * entity vocabulary names repo and invite.
 *
 * ONE LIST FOR BOTH PANE KINDS, because it is one enumerated subject with two
 * clauses hanging off it. Named for the card rather than for either pane, so neither
 * row reads as the owner of a set they share.
 */
type SidebarCardEntityKind = "participant" | "workspace" | "worktree" | "repo" | "invite";

/**
 * Every entity kind, decided. The exhaustiveness check, and the union's proof.
 *
 * A TOTAL map rather than a list of the admitted kinds, because a list grows a hole
 * silently — which is exactly how repo and invite went missing. The three intersected
 * constraints pin it in every direction that can be wrong: `Record<ConsoleEntityKind,
 * boolean>` means a kind added to `CONSOLE_ENTITY_KINDS` fails to compile here until
 * the sidebar-card question is answered for it, and the two halves after it hold this
 * map and the union above to the SAME set — every union member `true`, every other
 * kind `false` — so the union cannot quietly become narrower or wider than the table
 * the runtime filters with.
 */
const SIDEBAR_CARD_ADMITS_ENTITY_KIND = {
  session: false,
  participant: true,
  channel: false,
  run: false,
  agent: false,
  workspace: true,
  worktree: true,
  artifact: false,
  approval: false,
  "workflow-definition": false,
  "workflow-run": false,
  "browser-page": false,
  repo: true,
  invite: true,
} as const satisfies Record<ConsoleEntityKind, boolean> &
  Record<SidebarCardEntityKind, true> &
  Record<Exclude<ConsoleEntityKind, SidebarCardEntityKind>, false>;

/** The same set as data, filtered from the map so the two halves cannot drift. */
const SIDEBAR_CARD_ENTITY_KINDS: readonly SidebarCardEntityKind[] = CONSOLE_ENTITY_KINDS.filter(
  (kind): kind is SidebarCardEntityKind => SIDEBAR_CARD_ADMITS_ENTITY_KIND[kind],
);

/**
 * What each pane kind is a view of. THE declaration.
 *
 * `never` where the pane is session-scoped and takes no entity; `| undefined`
 * where the pane renders without one and its own governing module says so. A
 * kind added to `PANE_KINDS` is a compile error here until its scope is decided,
 * which is the site where a new pane kind needs that decision anyway — the same
 * totality `src/shared/auxiliary-routes.ts` imposes on its label and context
 * tables.
 */
interface PaneEntityScopeByKind {
  /** Session-scoped when bare, channel-scoped when a channel is named. */
  readonly timeline: ScopedEntityRef<"channel"> | undefined;
  /** Keyed by the inspected entity's own kind; there is nothing to inspect without one. */
  readonly inspector: ScopedEntityRef<SidebarCardEntityKind>;
  /** The session's runs list. */
  readonly runs: never;
  /** The session's approvals queue. */
  readonly approvals: never;
  /**
   * The changes of the entity the pane was opened from — the same card's second
   * clause, so the same kinds. What an invite's or a member's changes render is the
   * repos and collaboration families' question; that this address exists at all is
   * what lets them answer it without reopening this module.
   */
  readonly diff: ScopedEntityRef<SidebarCardEntityKind>;
  readonly artifact: ScopedEntityRef<"artifact">;
  readonly "workflow-run": ScopedEntityRef<"workflow-run">;
  /** Bare from the workflows destination; over a definition once one is saved. */
  readonly "workflow-builder": ScopedEntityRef<"workflow-definition"> | undefined;
  /**
   * One page per browser pane, keyed by the pane's own id and nothing else.
   *
   * Session-scoped rather than over a page reference, because the identity a page
   * reference would name does not exist: every registered browser operation in
   * `bridge/growth-signatures/panes.ts` — navigate, reload, stop, back, forward, and the
   * navigation subscription — takes the `paneId`, and the navigation state they
   * stream back carries a url, a title, and three flags and no page identifier at
   * all. Nothing in this build produces such an entity, so requiring one would
   * make every caller mint an identifier the seam never issues, and would refuse
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
  timeline: { entityKinds: ["channel"], entityRequired: false },
  inspector: { entityKinds: SIDEBAR_CARD_ENTITY_KINDS, entityRequired: true },
  runs: { entityKinds: [], entityRequired: false },
  approvals: { entityKinds: [], entityRequired: false },
  diff: { entityKinds: SIDEBAR_CARD_ENTITY_KINDS, entityRequired: true },
  artifact: { entityKinds: ["artifact"], entityRequired: true },
  "workflow-run": { entityKinds: ["workflow-run"], entityRequired: true },
  "workflow-builder": { entityKinds: ["workflow-definition"], entityRequired: false },
  browser: { entityKinds: [], entityRequired: false },
  terminal: { entityKinds: [], entityRequired: false },
  "agent-console": { entityKinds: ["agent"], entityRequired: false },
};

// Consumed by T-023p-1C-2, T-023p-1C-3
/** One pane kind's entity scope, as a caller deciding at runtime reads it. */
export interface PaneEntityScopeDeclaration {
  /** The entity kinds this pane may be opened over. Empty means session-scoped. */
  readonly entityKinds: readonly ConsoleEntityKind[];
  /** Whether the pane must be opened over one of them. */
  readonly entityRequired: boolean;
}

// Consumed by T-023p-1C-2, T-023p-1C-3
/**
 * One pane kind's entity scope, for the callers that decide at runtime — the
 * deck's layout validator and the sidebar's open-pane call.
 *
 * The read door onto the table above, so no caller keeps its own copy of a row.
 */
export function paneEntityScopeFor(kind: PaneKind): PaneEntityScopeDeclaration {
  return PANE_ENTITY_SCOPES[kind];
}

/**
 * The pane kinds whose address can be written bare — session-scoped, or entity-optional.
 *
 * Derived from the one declaration rather than listed, so a kind whose scope changes
 * moves between the two sides of this predicate without anybody editing a list.
 */
type EntityOptionalPaneKind = {
  [K in PaneKind]: EntityRequired<K> extends true ? never : K;
}[PaneKind];

/**
 * Whether this kind's address may be written with no entity.
 *
 * A narrowing predicate rather than a bare boolean read, because it is what lets the
 * parse RETURN the bare address without a cast: the table's `entityRequired` column is
 * annotated `EntityRequired<K>`, so the runtime value and the type it narrows to are
 * the same fact, checked by the compiler at the table rather than asserted here.
 */
function isEntityOptionalPaneKind(kind: PaneKind): kind is EntityOptionalPaneKind {
  return !PANE_ENTITY_SCOPES[kind].entityRequired;
}

/**
 * The entity reference an untyped boundary supplied, or `undefined` when it supplied none.
 *
 * The id is held to the console's ONE identifier grammar rather than to `id.length`.
 * A non-empty check admits whitespace, a NUL, a path, and a string of any length, and
 * the parse then answered with a valid pane address whose body would query a store key
 * that can never exist — `Spec-023 §Console Design (Meridian)` §The surface set's "an
 * entity id that fails validation is rejected", unenforced.
 *
 * The grammar is `persistence/identifier-grammar.ts`'s, imported rather than restated:
 * the layout snapshot this parse reads back is written through that family's value
 * walk, so the durable boundary already holds this exact string to this exact
 * predicate. A second grammar here would let route resolution admit an id the layout
 * path refuses, which is one value with two answers.
 *
 * `packages/contracts` settles nothing broader for it. Its id schemas are per-entity
 * branded UUIDs (`SessionIdSchema` and its siblings), and `ConsoleEntityRef.id` is
 * deliberately kind-agnostic and wire-verbatim, so no contracts schema covers the
 * value this boundary holds — and none disagrees with the grammar that does.
 */
function readEntityRefCandidate(candidate: unknown): ConsoleEntityRef | undefined {
  if (typeof candidate !== "object" || candidate === null) {
    return undefined;
  }
  const { kind, id } = candidate as { readonly kind?: unknown; readonly id?: unknown };
  return typeof kind === "string" && typeof id === "string" && isSingleNameIdentifierShaped(id)
    ? ({ kind, id } as ConsoleEntityRef)
    : undefined;
}

// Consumed by T-023p-1C-2, T-023p-1C-3
/**
 * Admit one address that arrived untyped, or refuse it by name.
 *
 * The two callers are the boundaries where the compiler has no claim to make: a
 * layout snapshot read back off disk, which may predate or postdate this build,
 * and a route a person can type. `Spec-023 §Console Design (Meridian)` §The
 * surface set requires that "an unknown pane kind is dropped and reported, and
 * an entity id that fails validation is rejected"; this is the predicate both
 * drops are made against, so neither boundary decides for itself.
 *
 * A refusal rather than a throw, per `core/refusal.ts`: a restored layout with
 * one bad row drops that row and keeps the rest, and a caller that needs the
 * exception shape wraps it in `ConsoleRefusalError` at its own seam.
 */
export function parseConsolePaneAddress(
  candidateKind: unknown,
  candidateEntity: unknown,
): ConsolePaneAddress | ConsoleRefusal {
  if (!isPaneKind(candidateKind)) {
    return refuse(
      PANE_ADDRESS_ORIGIN,
      "pane-kind-unknown",
      `"${String(candidateKind)}" is not one of the ${String(PANE_KINDS.length)} pane kinds this build renders`,
    );
  }

  const scope = paneEntityScopeFor(candidateKind);

  if (candidateEntity === undefined) {
    if (!isEntityOptionalPaneKind(candidateKind)) {
      return refuse(
        PANE_ADDRESS_ORIGIN,
        "pane-entity-required",
        `a "${candidateKind}" pane is a view of one ${scope.entityKinds.join(" or ")} and was opened with none`,
      );
    }
    // No cast. The predicate narrowed `candidateKind` to the kinds whose arm has no
    // `entity` member or an optional one, and the bare object satisfies both — which
    // is the whole point of the optional arm: what the parse returns is now a value a
    // typed caller could have written by hand.
    return { kind: candidateKind };
  }

  const entity = readEntityRefCandidate(candidateEntity);
  if (entity === undefined) {
    return refuse(
      PANE_ADDRESS_ORIGIN,
      "pane-entity-malformed",
      // The length is named and the value is not, on the persistence grammar's own
      // discipline: a refusal that quoted the string it refused would carry that
      // string one layer past the boundary that stopped it.
      `a "${candidateKind}" pane was opened over a value that is not an entity reference — an entity reference is a kind and an identifier-shaped id (no whitespace, no path separator, at most ${String(PANE_ENTITY_ID_MAX_LENGTH)} characters)`,
    );
  }

  if (scope.entityKinds.length === 0) {
    return refuse(
      PANE_ADDRESS_ORIGIN,
      "pane-entity-unexpected",
      `a "${candidateKind}" pane is session-scoped and takes no entity, and was opened over a "${entity.kind}"`,
    );
  }

  if (!scope.entityKinds.includes(entity.kind)) {
    return refuse(
      PANE_ADDRESS_ORIGIN,
      "pane-entity-kind-mismatch",
      `a "${candidateKind}" pane is a view of one ${scope.entityKinds.join(" or ")} and was opened over a "${entity.kind}"`,
    );
  }

  // Sound on the same terms as the arm above, plus the admission just made:
  // `entity.kind` is now known to be one this pane kind's row lists, which is
  // exactly the union the arm's `entity` member is narrowed to.
  return { kind: candidateKind, entity } as ConsolePaneAddress;
}
