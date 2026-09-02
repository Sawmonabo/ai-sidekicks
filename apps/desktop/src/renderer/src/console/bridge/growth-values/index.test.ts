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
 * Every name the single `growth-values.ts` exported on the day it was split.
 *
 * Transcribed rather than derived, because a census derived from the thing it
 * censuses proves nothing: this list is the record of the surface BEFORE the move,
 * and its whole job is to disagree with the barrel if the move lost a name.
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
  "GrowthPaneError",
  "GrowthPrPreparationState",
  "GrowthSessionSummary",
  "GrowthTerminalChunk",
  "GrowthToolCall",
  "GrowthUnpricedFamilyCap",
];

/** The tail of the gitflow re-export clause, which the negative control cuts out. */
const GITFLOW_CLAUSE_TAIL = '} from "./gitflow.js";';

/** The five names that survive erasure, so the runtime module object carries them. */
const VALUE_EXPORTS: readonly string[] = [
  "GROWTH_ARTIFACT_REPLICATION_STATUSES",
  "GROWTH_ARTIFACT_STATES",
  "GROWTH_ARTIFACT_TYPES",
  "GROWTH_ARTIFACT_VISIBILITIES",
  "GROWTH_PR_PREPARATION_STATES",
];

/**
 * The names the barrel's export clauses actually list.
 *
 * Read off the clauses rather than off the whole file, so a name that appears only
 * in the header prose is not counted as an export.
 */
function exportedNames(source: string): readonly string[] {
  const names: string[] = [];
  for (const clause of source.matchAll(/export (?:type )?\{([^}]*)\}/g)) {
    for (const entry of (clause[1] ?? "").split(",")) {
      const name = entry.replace(/^\s*(?:type\s+)?/, "").trim();
      if (name.length > 0) {
        names.push(name);
      }
    }
  }
  return names;
}

describe("the growth-values barrel's export surface", () => {
  it("publishes exactly the names the single module published", () => {
    expect([...exportedNames(barrelSource)].sort()).toStrictEqual([...PRE_SPLIT_EXPORTS].sort());
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

    expect(exportedNames(withGitflowDropped).length).toBeLessThan(PRE_SPLIT_EXPORTS.length);
    expect([...exportedNames(withGitflowDropped)].sort()).not.toStrictEqual(
      [...PRE_SPLIT_EXPORTS].sort(),
    );
  });
});
