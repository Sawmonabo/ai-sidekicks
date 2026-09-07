// The barrel publishes exactly what the single module published.
//
// The values were split into one module per wire domain, which is a refactor with
// one observable risk: a name that reached a consumer before the split and reaches
// nobody after it. TypeScript cannot catch that on its own — every consumer in this
// tree compiles against a subset, so a dropped export that no in-tree file imports
// yet is invisible until a family branch reaches for it and finds nothing.
//
// So the export surface is PINNED. `PRE_SPLIT_EXPORTS` is the name list the single
// module carried at the split, transcribed once, and the cases below hold the barrel
// to it from both directions: nothing dropped, nothing silently added under cover of
// a refactor that was supposed to move text and nothing else.
//
// TWO READINGS, BECAUSE ONE CANNOT SEE THE OTHER. A runtime `import *` sees the five
// value exports and no type, since types are erased before this file runs; the
// barrel's own source text carries all of them. The census is read off the source and
// the value half is then checked against the real module object, so a barrel whose
// text and whose runtime disagree fails rather than passing on the text alone.

import { describe, expect, it } from "vitest";

import * as growthValues from "./index.js";

declare global {
  interface ImportMeta {
    glob: (
      pattern: string,
      options: { query: "?raw"; import: "default"; eager: true },
    ) => Record<string, string>;
  }
}

// The barrel's own text, inlined at transform time through Vite's raw glob —
// `node:fs` is banned in renderer programs, and this is the form `families.test.ts`
// and `panes/panes.test.ts` established for source reads.
const barrelSources = import.meta.glob("./index.ts", {
  query: "?raw",
  import: "default",
  eager: true,
});
const barrelSource = Object.values(barrelSources)[0] ?? "";

/**
 * Every name the single `growth-values.ts` exported on the day it was split, plus
 * every name a later change deliberately added.
 *
 * Transcribed rather than derived, because a census derived from the thing it
 * censuses proves nothing: this list is the record of the surface the split had to
 * preserve, and its whole job is to disagree with the barrel if a name is lost. A
 * name is added here only in the diff that adds the export, which is what keeps
 * "nothing silently added under cover of a refactor" a real claim rather than a
 * comment. Two such additions so far: `GrowthBranchContextReadRequest`, because the
 * registered branch-context read is keyed by one of two arms and the union naming
 * them earned a name once the signature table and the gate's read plan both read it,
 * and `GrowthNotificationPermission`, the shell reading that decides whether the
 * notification centre is the only surface an attention item reaches a person on.
 */
const PRE_SPLIT_EXPORTS: readonly string[] = [
  "GROWTH_ARTIFACT_REPLICATION_STATUSES",
  "GROWTH_ARTIFACT_STATES",
  "GROWTH_ARTIFACT_TYPES",
  "GROWTH_ARTIFACT_VISIBILITIES",
  "GROWTH_PR_PREPARATION_STATES",
  "GrowthArtifactDeleteReceipt",
  "GrowthArtifactPayloadDisposition",
  "GrowthArtifactPayloadEncoding",
  "GrowthArtifactRead",
  "GrowthArtifactReadDeferred",
  "GrowthArtifactReadInline",
  "GrowthArtifactReplicationStatus",
  "GrowthArtifactState",
  "GrowthArtifactSummary",
  "GrowthArtifactType",
  "GrowthArtifactVisibility",
  "GrowthAttachmentIngestCompletion",
  "GrowthAttentionPreference",
  "GrowthBranchContext",
  "GrowthBranchContextReadRequest",
  "GrowthBudgetState",
  "GrowthCallbackTool",
  "GrowthCostReceipt",
  "GrowthCostReceiptAccountRow",
  "GrowthCostReceiptCausedByRow",
  "GrowthCostReceiptRunRow",
  "GrowthCostStatus",
  "GrowthEffectivePrincipal",
  "GrowthHealthReading",
  "GrowthImportProgress",
  "GrowthInviteSummary",
  "GrowthNavigationState",
  "GrowthNotificationPermission",
  "GrowthPaneError",
  "GrowthPrPreparationState",
  "GrowthSessionSummary",
  "GrowthTerminalChunk",
  "GrowthToolCall",
  "GrowthUnpricedFamilyCap",
];

/**
 * Names the barrel published at the split and has since deliberately RETIRED.
 *
 * Kept beside the transcription rather than deleted from it, because the two lists say
 * different things: the one above records what the surface was, and this one records
 * every departure from it that was a decision. Editing a name out of the record would
 * make a lost name and a retired name indistinguishable, which is the whole property
 * that census exists to hold.
 *
 * The first five are the artifact vocabulary's runtime lists and its two read arms.
 * Nothing in the tree read them: a consumer of the vocabulary takes the DERIVED type,
 * where `Record<GrowthArtifactState, …>` is total in both directions at compile time,
 * and a consumer of the read union narrows it structurally on `payload`, which is
 * `never` on the deferred arm. A published list beside a derived type is a second way
 * to ask one question, and only one of the two ways is checked.
 *
 * The last six are the cost receipt's row shapes, its status vocabulary, its principal
 * and its cap. Each carried a per-specifier line naming the cost page as the reader
 * that would import it; that page has landed and derives every one of them off
 * `GrowthCostReceipt`, which stays published and is the closed set's one home. A door
 * line whose named consumer arrived and did not take it can never retire itself, so
 * the line is retired instead — which is the disposition `apps/desktop/AGENTS.md`
 * names for a door line with no production reader.
 */
const RETIRED_SINCE_SPLIT: readonly string[] = [
  "GROWTH_ARTIFACT_REPLICATION_STATUSES",
  "GROWTH_ARTIFACT_STATES",
  "GROWTH_ARTIFACT_VISIBILITIES",
  "GrowthArtifactReadDeferred",
  "GrowthArtifactReadInline",
  "GrowthCostReceiptAccountRow",
  "GrowthCostReceiptCausedByRow",
  "GrowthCostReceiptRunRow",
  "GrowthCostStatus",
  "GrowthEffectivePrincipal",
  "GrowthUnpricedFamilyCap",
];

/** What the barrel is expected to publish today: the split's surface, less the retired. */
const CURRENT_EXPORTS: readonly string[] = PRE_SPLIT_EXPORTS.filter(
  (name) => !RETIRED_SINCE_SPLIT.includes(name),
);

/** The tail of the gitflow re-export clause, which the negative control cuts out. */
const GITFLOW_CLAUSE_TAIL = '} from "./gitflow.js";';

/** The two names that survive erasure, so the runtime module object carries them. */
const VALUE_EXPORTS: readonly string[] = ["GROWTH_ARTIFACT_TYPES", "GROWTH_PR_PREPARATION_STATES"];

/**
 * The names the barrel's export clauses actually list.
 *
 * Read off the clauses rather than off the whole file, so a name that appears only
 * in the header prose is not counted as an export.
 */
function exportedNames(source: string): readonly string[] {
  const names: string[] = [];
  for (const clause of source.matchAll(/export (?:type )?\{([^}]*)\}/g)) {
    // Comments are cut before the split, not after: a per-specifier marker naming
    // the task that will import a name is not itself a name, and one naming two
    // tasks carries a comma that would otherwise split one entry into two.
    const listed = (clause[1] ?? "").replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
    for (const entry of listed.split(",")) {
      const name = entry.replace(/^\s*(?:type\s+)?/, "").trim();
      if (name.length > 0) {
        names.push(name);
      }
    }
  }
  return names;
}

describe("the growth-values barrel's export surface", () => {
  it("publishes the names the single module published, less the retired ones", () => {
    expect([...exportedNames(barrelSource)].sort()).toStrictEqual([...CURRENT_EXPORTS].sort());
  });

  it("retires only names the split actually published, and publishes none of them", () => {
    // Without this the retirement list could drift into naming something that was
    // never there, which would silently shrink what the census above demands — the
    // one way a deliberate list can weaken the record it sits beside.
    expect(RETIRED_SINCE_SPLIT.filter((name) => !PRE_SPLIT_EXPORTS.includes(name))).toStrictEqual(
      [],
    );
    expect(
      RETIRED_SINCE_SPLIT.filter((name) => exportedNames(barrelSource).includes(name)),
    ).toStrictEqual([]);
    expect(RETIRED_SINCE_SPLIT.length).toBeGreaterThan(0);
  });

  it("names each export once — a re-export chain would publish two of one name", () => {
    const names = exportedNames(barrelSource);

    expect(names.length).toBe(new Set(names).size);
  });

  it("hands back the value exports at runtime, not only in its text", () => {
    // The half erasure leaves behind. A barrel whose text lists a value it does not
    // actually re-export would pass the census above and fail here.
    expect(Object.keys(growthValues).sort()).toStrictEqual([...VALUE_EXPORTS].sort());
    expect(growthValues.GROWTH_ARTIFACT_TYPES).toContain("workflow_output");
    expect(growthValues.GROWTH_PR_PREPARATION_STATES).toStrictEqual(["draft", "ready"]);
  });

  it("negative control: the census fails on a barrel that dropped a name", () => {
    // The check has to be able to fail, and this is the exact state it exists to
    // catch: a domain module moved out and its `export` clause never written. The
    // clause is cut by its own delimiters rather than matched by a pattern, so the
    // control cannot silently stop cutting anything and pass on the untouched text.
    const clauseEnd = barrelSource.indexOf(GITFLOW_CLAUSE_TAIL);
    const clauseStart = barrelSource.lastIndexOf("export {", clauseEnd);
    expect(clauseStart).toBeGreaterThan(0);
    const withGitflowDropped =
      barrelSource.slice(0, clauseStart) +
      barrelSource.slice(clauseEnd + GITFLOW_CLAUSE_TAIL.length);

    expect(exportedNames(withGitflowDropped).length).toBeLessThan(CURRENT_EXPORTS.length);
    expect([...exportedNames(withGitflowDropped)].sort()).not.toStrictEqual(
      [...CURRENT_EXPORTS].sort(),
    );
  });
});
