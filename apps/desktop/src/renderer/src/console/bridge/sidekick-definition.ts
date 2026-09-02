// The saved sidekick configuration the definitions page reads and writes, declared
// here because no code package carries it.
//
// `Spec-030 §Interfaces And Contracts` registers a five-verb `sidekick.*` namespace
// and `api-payload-contracts.md §Plan-030 — Sidekick Definitions And Peer Invocation`
// registers its shapes; `packages/contracts` carries none of them, and neither does
// the client SDK. A definitions page whose stored row exists nowhere would have to
// invent it inside a view family, which is what the growth slate exists to prevent —
// so the shape is declared here, on the substrate, behind the
// `sidekick-definition-registry` slate row, and every call to it goes through the
// growth port.
//
// DELETION OBLIGATION. When `packages/contracts` registers these types, this module
// is DELETED and `growth-signatures.ts` imports them from the contracts package
// instead. The slate row leaves `growth-slate.ts` and `Plan-023 §Console growth
// slate` in the same PR, and `failure-modes.test.ts` then fails on the port entries
// that still claim fixture-only — which is the reminder this file wants at that
// moment.
//
// WHY THE DRAFT AND THE STORED ROW ARE TWO SHAPES AND NOT ONE. The registered
// contract makes the difference load-bearing, so collapsing them would erase it. On
// a WRITE, an absent axis means "leave it to the default" and an explicit `null`
// means "stop pinning this"; on the STORED row there is no absence at all — the
// inherit state IS `null`, materialized. A single shape could express one grammar or
// the other and not both, and the one it dropped is the one an operator needs to
// clear an account or an effort they had pinned.
//
// WHAT IS DELIBERATELY NOT HERE. The `sidekick.peerInvocationSet` pair. It is the
// per-session opt-in rather than a definition, its durable home is a session event
// rather than this registry, and no surface on this substrate sets it — a shape
// declared for it now would be minted ahead of its reader. It comes here with the
// surface that turns peer invocation on.

/**
 * The execution postures a definition may pin. Closed, declared once, derived below.
 *
 * A posture MODE only. The registered contract is explicit that a composed posture
 * does not belong on a saved row: writable roots and the credential policy are
 * properties of a live run's workspace, so storing them would freeze a path set that
 * outlives the workspace it described.
 */
export const SIDEKICK_POSTURE_MODES = [
  "trusted",
  "workspace-sandboxed",
  "readonly-sandboxed",
] as const;

/** One pinned execution posture. Derived, so the vocabulary has one home. */
export type SidekickPostureMode = (typeof SIDEKICK_POSTURE_MODES)[number];

/**
 * One saved definition, as the registry serves it.
 *
 * Every nullable axis is `T | null` rather than optional, and that is the stored
 * grammar rather than a style choice: a read never omits an axis, so `null` is how
 * the row says "inherit". `description` and `instructions` are required and may be
 * empty strings — an operator who wrote nothing wrote nothing, which is a value.
 *
 * `definitionId` is the identity and `name` is the label. They are separate axes on
 * purpose: a rename must not orphan a stored reference, so nothing keys on the name.
 */
export interface SidekickDefinition {
  readonly definitionId: string;
  /** Mutable label, unique per node under full Unicode case folding. */
  readonly name: string;
  readonly description: string;
  readonly driverName: string;
  readonly modelId: string;
  /** `null` resolves the provider's default account at attach time. */
  readonly providerAccountId: string | null;
  /** `null` takes the driver's default; validated at resolution, never here. */
  readonly effort: string | null;
  readonly executionPostureMode: SidekickPostureMode | null;
  readonly instructions: string;
  readonly goal: string | null;
  /**
   * Three-state and deliberately not two: `null` is the driver's defaults, `[]` is
   * no tools at all, populated is exactly these. Collapsing the first two would make
   * "I did not choose" indistinguishable from "I chose nothing".
   */
  readonly toolAllowlist: readonly string[] | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * What a create request carries: the axis set, in its WRITE grammar.
 *
 * Declared once and reused by the update signature as a `Partial`, because the
 * registered update is exactly this with every axis optional and a `definitionId`
 * added. Two hand-written axis lists would drift the first time an axis landed on
 * one and not the other, and the compiler would have nothing to say about it.
 */
export interface SidekickDefinitionDraft {
  readonly name: string;
  readonly description?: string;
  readonly driverName: string;
  readonly modelId: string;
  readonly providerAccountId?: string | null;
  readonly effort?: string | null;
  readonly executionPostureMode?: SidekickPostureMode | null;
  readonly instructions?: string;
  readonly goal?: string | null;
  readonly toolAllowlist?: readonly string[] | null;
}
