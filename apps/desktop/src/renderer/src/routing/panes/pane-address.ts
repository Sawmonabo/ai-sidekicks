// Which pane, over which entity, and which entities each pane kind admits. `PaneEntityScopeByKind`
// is the one declaration; the static `PaneAddress` union and the runtime table that
// `parse-pane-address.ts` reads both derive from it, so they cannot drift.

import { ENTITY_KINDS, type EntityKind, type EntityRef } from "@renderer/lib/entity-kinds.js";
import { type PaneKind } from "./pane-kinds.js";

/** A `EntityRef` narrowed to the kinds one pane kind admits. */
type ScopedEntityRef<TEntityKind extends EntityKind> = EntityRef & {
  readonly kind: TEntityKind;
};

/**
 * The entity kinds that own a checkout, which the inspector and the diff pane are both
 * views of: a worktree on a project session, a workspace on a chat.
 */
type CheckoutEntityKind = "workspace" | "worktree";

/**
 * Every entity kind, decided. A total map, so a kind added to `ENTITY_KINDS` fails to compile
 * until the checkout question is answered for it; the intersected records pin it to exactly
 * `CheckoutEntityKind`.
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
} as const satisfies Record<EntityKind, boolean> &
  Record<CheckoutEntityKind, true> &
  Record<Exclude<EntityKind, CheckoutEntityKind>, false>;

/** The same set as data, filtered from the map so the two halves cannot drift. */
const CHECKOUT_ENTITY_KINDS: readonly CheckoutEntityKind[] = ENTITY_KINDS.filter(
  (kind): kind is CheckoutEntityKind => CHECKOUT_ADMITS_ENTITY_KIND[kind],
);

/**
 * Which pane, over which entity: the address a pane is opened at.
 *
 * A discriminated union over `kind`, so narrowing on the kind narrows the entity with it, and a
 * `transcript` arm has no `entity` member to read.
 */
export type PaneAddress = { [K in PaneKind]: PaneAddressOf<K> }[PaneKind];

/**
 * One pane kind's address arm, entity member and all.
 *
 * Three shapes: a session-scoped kind has no `entity` member (a compile-time fact, not an
 * always-undefined one), a bare-reference kind requires one, and a kind whose scope includes
 * `undefined` takes an optional one. The optional member keeps `| undefined` so that under
 * `exactOptionalPropertyTypes` both an absent key and `entity: undefined` compile.
 */
export type PaneAddressOf<TKind extends PaneKind> = [PaneEntityScopeByKind[TKind]] extends [never]
  ? { readonly kind: TKind }
  : EntityRequired<TKind> extends true
    ? { readonly kind: TKind; readonly entity: PaneEntityScopeByKind[TKind] }
    : { readonly kind: TKind; readonly entity?: PaneEntityScopeByKind[TKind] };

/**
 * What each pane kind is a view of. The one declaration.
 *
 * `never` where the pane is session-scoped and takes no entity; `| undefined` where the pane
 * renders without one. A kind added to `PANE_KINDS` fails to compile here until its scope is
 * decided.
 */
interface PaneEntityScopeByKind {
  /** The session's transcript. */
  readonly transcript: never;
  /** Keyed by the inspected checkout's own kind; there is nothing to inspect without one. */
  readonly inspector: ScopedEntityRef<CheckoutEntityKind>;
  /** The changes of the checkout the pane was opened from, so the same kinds. */
  readonly diff: ScopedEntityRef<CheckoutEntityKind>;
  readonly "workflow-run": ScopedEntityRef<"workflow-run">;
  /** Bare from the workflows destination; over a definition once one is saved. */
  readonly "workflow-builder": ScopedEntityRef<"workflow-definition"> | undefined;
  /**
   * Session-scoped: browser operations are keyed by the pane's own id and no page entity is
   * ever issued, so requiring one would refuse `parsePaneAddress("browser", undefined)`, the
   * shape both untyped boundaries supply for a bare pane.
   */
  readonly browser: never;
  /** Session-scoped: a terminal address names no entity. */
  readonly terminal: never;
  /** Bare is the picker arm: a session is chosen and no agent is named yet. */
  readonly agents: ScopedEntityRef<"agent"> | undefined;
}
/** The entity kinds one pane kind admits, read off the declaration. */
type AdmittedEntityKind<TKind extends PaneKind> = NonNullable<PaneEntityScopeByKind[TKind]>["kind"];

/**
 * Whether one pane kind must be opened over an entity. False for session-scoped and for
 * entity-optional kinds; true only when the scope is a bare reference.
 */
type EntityRequired<TKind extends PaneKind> = undefined extends PaneEntityScopeByKind[TKind]
  ? false
  : [PaneEntityScopeByKind[TKind]] extends [never]
    ? false
    : true;

/**
 * The same scopes as data, for the boundaries the compiler has no claim over.
 *
 * Typed as a mapped type over the declaration, so a row naming an entity kind its arm does not
 * admit, or disagreeing on whether the entity is required, fails to compile. A row naming fewer
 * kinds than its arm admits fails closed: the parse refuses an address the union allows.
 */
const PANE_ENTITY_SCOPES: {
  readonly [K in PaneKind]: {
    readonly entityKinds: readonly AdmittedEntityKind<K>[];
    readonly entityRequired: EntityRequired<K>;
  };
} = {
  transcript: { entityKinds: [], entityRequired: false },
  inspector: { entityKinds: CHECKOUT_ENTITY_KINDS, entityRequired: true },
  diff: { entityKinds: CHECKOUT_ENTITY_KINDS, entityRequired: true },
  "workflow-run": { entityKinds: ["workflow-run"], entityRequired: true },
  "workflow-builder": { entityKinds: ["workflow-definition"], entityRequired: false },
  browser: { entityKinds: [], entityRequired: false },
  terminal: { entityKinds: [], entityRequired: false },
  agents: { entityKinds: ["agent"], entityRequired: false },
};

/** One pane kind's entity scope, as a caller deciding at runtime reads it. */
export interface PaneEntityScopeDeclaration {
  /** The entity kinds this pane may be opened over. Empty means session-scoped. */
  readonly entityKinds: readonly EntityKind[];
  /** Whether the pane must be opened over one of them. */
  readonly entityRequired: boolean;
}

/**
 * The pane kinds whose address can be written bare (session-scoped or entity-optional),
 * derived from the one declaration.
 */
export type EntityOptionalPaneKind = {
  [K in PaneKind]: EntityRequired<K> extends true ? never : K;
}[PaneKind];

/**
 * How a pane names itself as the pane another was opened from.
 *
 * An object rather than a bare string so the call site reads as a link. The whole value is
 * optional on the opener, so there is one way to say "no link".
 */
export interface PaneLink {
  readonly linkedSourcePaneId: string;
}

/**
 * The call a card and the palette make to open a pane.
 *
 * The pane layout copies `link` onto the new pane's `PaneContext.linkedSourcePaneId`; it is
 * optional because a card or the palette opens from a list, not from a pane.
 */
export type PaneOpener = (address: PaneAddress, link?: PaneLink) => void;

/** One pane kind's entity scope, read by the address parse; the one reader of the table above. */
export function paneEntityScopeFor(kind: PaneKind): PaneEntityScopeDeclaration {
  return PANE_ENTITY_SCOPES[kind];
}

/**
 * Whether this kind's address may be written with no entity.
 *
 * A narrowing predicate so `parsePaneAddress` can return a bare address without a cast; the
 * table's `entityRequired` column is typed `EntityRequired<K>`, so value and narrowing agree.
 */
export function isEntityOptionalPaneKind(kind: PaneKind): kind is EntityOptionalPaneKind {
  return !PANE_ENTITY_SCOPES[kind].entityRequired;
}
