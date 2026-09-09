// The scenario manifest: the fixture's ledger of what it serves and what it owes.
//
// SIX MEMBERS — count `ConsoleScenarioManifest` below, which is the declaration — and
// the reason there are six rather than one:
//
//   • `scenarios` — the scripted sessions the fixture can play.
//   • `frozenTicks` — per scenario, the frames the capture tiers pin.
//   • `growthOperations` — one row per eventual bridge operation, each naming the
//     `Plan-023 §Console growth slate` row it serves and whether the fixture has a
//     script for it. Operations are what a surface CALLS.
//   • `prerequisites` — the rest of the slate: types, settings keys, pane-kind
//     declarations, event-type registrations, error namespaces, and one governing
//     document that does not exist yet. These are what a slate row needs and a
//     surface never calls, so they are ledgered here and never become port methods.
//   • `slateRows` — the slate itself, which the two ledgers above are checked against.
//   • `fixtureServedOperations` — which of those operations the fixture answers.
//
// NOT ONE OF THE SIX IS DECLARED HERE. Every one is read from the module that owns it —
// the seat board for the scenarios, `frozen-tick-registry.ts` for the ticks, the growth
// port for the slate and its prerequisites, the fixture for what it serves — because
// the manifest is the place they are ASSERTED against each other and never a second
// home for any one of them. That assertion is `failure-modes.test.ts`' registry walk,
// which reads every side off ONE manifest: a walk that read each shipped registry
// directly would agree with itself no matter what a surface was actually handed.
//
// I-023-13's test reads them and asserts the two directions that matter: no slate row is
// unmapped, and no ledger entry names a row that is not on the slate. The second
// direction is the one that fires the day a wire lands — the row leaves the slate, and
// the entry still claiming `fixture-only` fails the build, which is precisely the
// reminder the console wants at that moment.

import type {
  GrowthOperationEntry,
  GrowthOperationId,
  GrowthPrerequisiteEntry,
} from "../growth-port/index.js";
import { FIXTURE_SERVED_GROWTH_OPERATION_IDS } from "../fixture/index.js";
import { GROWTH_OPERATIONS } from "../growth-operations/index.js";
import { GROWTH_PREREQUISITES } from "../growth-port/index.js";
import {
  GROWTH_SLATE_ROWS,
  type GrowthSlateRow,
  type GrowthSlateRowId,
} from "../growth-port/index.js";
import type { ConsoleScenario } from "./runtime/vocabulary.js";
import { SCENARIO_FROZEN_TICKS, type ScenarioFrozenTick } from "./runtime/frozen-tick-registry.js";
// The scenario list lives in `scenario/corpus.ts`, which holds one reserved line
// per view family. Seven families ship concurrently; an array they all edit here
// would conflict six ways, and the conflict resolves cleanly while dropping a
// family's scenario. This module reads the list rather than owning it.
import { CONSOLE_SCENARIOS } from "./corpus.js";

export { CONSOLE_SCENARIOS };

/**
 * Growth operations the fixture has a scripted answer for.
 *
 * Read from `fixture/call-plane/served-operations.ts`, which declares the membership the port
 * implements against, rather than listed again here. The set that DECIDES which
 * operations are served and the ledger that RECORDS the fixture serving one are two
 * claims about one set, and two hand-written lists is how they come apart —
 * silently, because a ledger claiming a served operation nobody implements reads
 * exactly like a correct one.
 */
export const FIXTURE_SERVED_GROWTH_OPERATIONS: readonly GrowthOperationId[] =
  FIXTURE_SERVED_GROWTH_OPERATION_IDS;

export interface ConsoleScenarioManifest {
  readonly scenarios: readonly ConsoleScenario[];
  readonly frozenTicks: Readonly<Record<string, readonly ScenarioFrozenTick[]>>;
  readonly growthOperations: readonly GrowthOperationEntry[];
  readonly prerequisites: readonly GrowthPrerequisiteEntry[];
  readonly slateRows: readonly GrowthSlateRow[];
  readonly fixtureServedOperations: readonly GrowthOperationId[];
}

/**
 * The manifest, composed on demand.
 *
 * A FUNCTION AND NEVER A MODULE-LEVEL CONSTANT, and the reason is a measured
 * bundler property rather than a style preference. This value was
 * `export const CONSOLE_SCENARIO_MANIFEST = { … Object.values(GROWTH_OPERATIONS) … }`
 * until 2026-09-06, and a top-level initializer that CALLS a function is not
 * provably pure to the bundler, so Rollup retained the whole declaration in a
 * release build even though every reader of it is a test. Retaining it retained
 * `CONSOLE_SCENARIOS`, and that retained all nine scenario modules and the four
 * `fixture/` modules they reach — the corpus `Spec-023 §Console Design (Meridian)`
 * §The fixture bridge says a release bundle carries none of. Measured on the
 * release artifact: `"Browsing agent"`, `artifact-capture-staging-header`, and
 * `fixtureServedOperations` were all grep-positive in `index-*.js`.
 *
 * A function body is evaluated only when it is called, and an unreferenced function
 * declaration is dropped whether or not its body is pure — so the same composition
 * expressed this way leaves the release graph entirely. The two callers are the
 * default parameters below, which are themselves evaluated per call.
 *
 * `test/console/budget/release-absence.test.ts` sweeps the built artifact for the
 * corpus so this cannot silently come back.
 */
export function consoleScenarioManifest(): ConsoleScenarioManifest {
  return {
    scenarios: CONSOLE_SCENARIOS,
    frozenTicks: SCENARIO_FROZEN_TICKS,
    growthOperations: Object.values(GROWTH_OPERATIONS),
    prerequisites: Object.values(GROWTH_PREREQUISITES),
    slateRows: GROWTH_SLATE_ROWS,
    fixtureServedOperations: FIXTURE_SERVED_GROWTH_OPERATIONS,
  };
}

/** Every ledger entry that serves one slate row, in both categories. */
export interface SlateRowCoverage {
  readonly row: GrowthSlateRow;
  readonly operations: readonly GrowthOperationEntry[];
  readonly prerequisites: readonly GrowthPrerequisiteEntry[];
}

/**
 * Map each slate row to the ledger entries that serve it. A row with neither is the
 * failure I-023-13 exists to catch: the console named a wire it needs and then
 * built nothing that would consume it.
 */
export function mapSlateRowCoverage(
  manifest: ConsoleScenarioManifest = consoleScenarioManifest(),
): readonly SlateRowCoverage[] {
  return manifest.slateRows.map((row) => ({
    row,
    operations: manifest.growthOperations.filter((entry) => entry.slateRow === row.id),
    prerequisites: manifest.prerequisites.filter((entry) => entry.slateRow === row.id),
  }));
}

/** Row ids named by a ledger entry but absent from the slate. Must be empty. */
export function findOrphanedLedgerRowIds(
  manifest: ConsoleScenarioManifest = consoleScenarioManifest(),
): readonly GrowthSlateRowId[] {
  const known = new Set(manifest.slateRows.map((row) => row.id));
  const named = new Set<GrowthSlateRowId>();
  for (const entry of manifest.growthOperations) {
    named.add(entry.slateRow);
  }
  for (const entry of manifest.prerequisites) {
    named.add(entry.slateRow);
  }
  return [...named].filter((id) => !known.has(id));
}

/** Scenario lookup by id. Throws rather than returning a silent default. */
export function consoleScenario(scenarioId: string): ConsoleScenario {
  const scenario = CONSOLE_SCENARIOS.find((candidate) => candidate.id === scenarioId);
  if (scenario === undefined) {
    throw new RangeError(
      `no console scenario named "${scenarioId}" (have: ${CONSOLE_SCENARIOS.map((candidate) => candidate.id).join(", ")})`,
    );
  }
  return scenario;
}
