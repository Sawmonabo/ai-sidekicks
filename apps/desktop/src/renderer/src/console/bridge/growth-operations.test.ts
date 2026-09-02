// Does the ledger's workflow block say what the owning contract says?
//
// The rest of the ledger is audited structurally — `failure-modes.test.ts` maps
// every slate row to its entries in both directions, and `fixture-growth-port.test.ts`
// calls every operation and checks which answer. Neither reads what an entry CLAIMS,
// and for most rows there is nothing to read: a browser or terminal operation names
// no wire method because none is registered anywhere to name.
//
// The workflow block is the first where every operation names one. Those nine
// strings are a transcription of a registry the console does not import and cannot,
// so the one defect worth catching here is the transcription's own failure mode: a
// method paired with the wrong operation. That is invisible to every structural
// check — a mispaired entry has a row, a slate attribution, and a port method, and
// the only thing wrong with it is that a surface calling `runResume` would be built
// against `runCancel`'s shape.
//
// The pairing is checkable because the id encodes it: an operation id is its wire
// method with the root folded into camelCase, so the method can be derived from the
// id and compared. That derivation is this file's, not production's — there is no
// production rule to reimplement, and the entry's own literal is what it checks.

import { describe, expect, it } from "vitest";

import type { GrowthOperationId } from "./growth-entry.js";
import { GROWTH_OPERATIONS } from "./growth-operations.js";
import type { GrowthSlateRowId } from "./growth-slate.js";

const WORKFLOW_SLATE_ROW: GrowthSlateRowId = "workflow-run-control";

/** Every operation attributed to one slate row, read from the ledger itself. */
function operationsServingRow(slateRow: GrowthSlateRowId): readonly GrowthOperationId[] {
  return (Object.keys(GROWTH_OPERATIONS) as GrowthOperationId[]).filter(
    (operationId) => GROWTH_OPERATIONS[operationId].slateRow === slateRow,
  );
}

/**
 * The wire method an operation id folds to: the root, a dot, and the rest of the id
 * with its first letter lowered.
 *
 * Total over any string, so the negative control below can drive it over an id the
 * ledger does not carry.
 */
function wireMethodFoldedFrom(operationId: string, root: string): string {
  const tail = operationId.slice(root.length);
  return `${root}.${tail.charAt(0).toLowerCase()}${tail.slice(1)}`;
}

describe("the growth ledger's workflow block — one registered method per operation", () => {
  it("attributes nine operations to the row, every one an RPC method", () => {
    const workflowOperationIds = operationsServingRow(WORKFLOW_SLATE_ROW);

    // Nine of the registry's thirteen rows. The count is stated rather than derived
    // because it is the claim: the row deliberately leaves out the two authoring
    // writes, the version read, and the handler-less draft save, and a tenth
    // operation appearing here without that decision being revisited is the drift
    // worth failing on.
    expect(workflowOperationIds).toHaveLength(9);
    for (const operationId of workflowOperationIds) {
      expect(GROWTH_OPERATIONS[operationId].kind, operationId).toBe("method");
    }
  });

  it("names the registered method its own id folds to, so no entry is mispaired", () => {
    for (const operationId of operationsServingRow(WORKFLOW_SLATE_ROW)) {
      expect(GROWTH_OPERATIONS[operationId].expectedWireMethod, operationId).toBe(
        wireMethodFoldedFrom(operationId, "workflow"),
      );
    }
  });

  it("names nine distinct methods, so no two operations reach one wire", () => {
    const methods = operationsServingRow(WORKFLOW_SLATE_ROW).map(
      (operationId) => GROWTH_OPERATIONS[operationId].expectedWireMethod,
    );

    expect(new Set(methods).size).toBe(methods.length);
  });

  it("negative control: the same fold rejects an entry whose method is another's", () => {
    // Without this, the pairing check above would hold over a ledger where every
    // entry carried the same string — `toBe` against a value derived from the id is
    // only meaningful if a wrong value is reachable, and this is what a wrong one
    // looks like: a real registered method, on the wrong operation.
    const mispaired = {
      ...GROWTH_OPERATIONS.workflowRunResume,
      expectedWireMethod: GROWTH_OPERATIONS.workflowRunCancel.expectedWireMethod,
    };

    expect(mispaired.expectedWireMethod).not.toBe(wireMethodFoldedFrom(mispaired.id, "workflow"));
  });

  it("negative control: an operation whose row registers no method names none", () => {
    // The check above is about rows that HAVE a registry. Most do not, and their
    // entries carry `undefined` rather than an invented string — so the workflow
    // block's nine are a real distinction rather than the shape every entry has.
    expect(GROWTH_OPERATIONS.browserNavigate.expectedWireMethod).toBeUndefined();
    expect(GROWTH_OPERATIONS.terminalWrite.expectedWireMethod).toBeUndefined();
  });
});
