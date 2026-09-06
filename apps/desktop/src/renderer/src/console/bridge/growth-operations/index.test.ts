// Does the ledger's workflow block say what the owning contract says?
//
// The rest of the ledger is audited structurally — `failure-modes.test.ts` maps
// every slate row to its entries in both directions, and `fixture-growth-port.test.ts`
// calls every operation and checks which answer. Neither reads what an entry CLAIMS,
// and for most rows there is nothing to read: a browser or terminal operation names
// no wire method because none is registered anywhere to name.
//
// Three blocks name one apiece for every operation they carry — workflow, sidekick,
// and the session cost plane.
// Those strings are transcriptions of registries the console does not import and
// cannot, so the one defect worth catching here is the transcription's own failure
// mode: a method paired with the wrong operation. That is invisible to every
// structural check — a mispaired entry has a row, a slate attribution, and a port
// method, and the only thing wrong with it is that a surface calling `runResume`
// would be built against `runCancel`'s shape.
//
// The pairing is checkable because the id encodes it: an operation id is its wire
// method with the root folded into camelCase, so the method can be derived from the
// id and compared. That derivation is this file's, not production's — there is no
// production rule to reimplement, and the entry's own literal is what it checks.
//
// AND ONE PROPERTY THE SPLIT COSTS, BOUGHT BACK BY COUNTING. The table is composed
// from eleven plane modules, so a key that appears in two of them is a silent override
// by the later spread rather than the compile error a duplicate inside one object
// literal used to be. The last block below asserts the planes' key sets are pairwise
// disjoint and that their sizes sum to the composed table's — against
// `GROWTH_OPERATION_PLANES`, the list `index.ts` itself spreads, so the check cannot
// drift from the composition by holding its own copy of it.

import { describe, expect, it } from "vitest";

import type { GrowthOperationId } from "../growth-port/growth-entry.js";
import { GROWTH_OPERATION_PLANES, GROWTH_OPERATIONS } from "./index.js";
import type { GrowthSlateRowId } from "../growth-port/growth-slate.js";

const WORKFLOW_SLATE_ROW: GrowthSlateRowId = "workflow-run-control";
const SIDEKICK_SLATE_ROW: GrowthSlateRowId = "sidekick-definition-registry";

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

describe("the growth ledger's run-enumeration row — the boundary of that registry", () => {
  it("carries one operation, and it names no wire method", () => {
    // The block above names a method for all nine of its operations because all
    // nine are registered. This row is where that registry stops rather than an
    // omission from it: every registered run operation addresses ONE run by an id
    // the caller must already hold, so a surface that lists runs has nothing to
    // call, and a `workflow.runList` literal here would be a string this console
    // invented — the position the two identity-and-registry rows below are in.
    const operationIds = operationsServingRow("workflow-run-enumeration");

    expect(operationIds).toStrictEqual(["workflowRunList"]);
    expect(GROWTH_OPERATIONS.workflowRunList.expectedWireMethod).toBeUndefined();
    expect(GROWTH_OPERATIONS.workflowRunList.kind).toBe("method");
  });

  it("stays out of the registered block, whose nine keep folding to their methods", () => {
    // The two claims read from opposite directions: the enumeration is attributed
    // away from the registered row, which is what keeps that row's every-operation
    // `toBe` fold above true. Attributing it there instead would fail this and the
    // fold together, which is the drift worth catching twice.
    expect(operationsServingRow(WORKFLOW_SLATE_ROW)).not.toContain("workflowRunList");
  });
});

describe("the growth ledger's sidekick block — the registry's five pairs", () => {
  it("attributes five operations to the row, every one an RPC method", () => {
    const sidekickOperationIds = operationsServingRow(SIDEKICK_SLATE_ROW);

    // All five. Stated rather than derived because it is the claim: the row carried
    // four while the per-session peer-invocation opt-in had no console surface to set
    // it, and the fifth joined when the agent console's peer-invocation control
    // landed. A sixth appearing here without that decision being revisited is the
    // drift worth failing on.
    expect(sidekickOperationIds).toHaveLength(5);
    for (const operationId of sidekickOperationIds) {
      expect(GROWTH_OPERATIONS[operationId].kind, operationId).toBe("method");
    }
  });

  it("names the registered method its own id folds to, so no entry is mispaired", () => {
    for (const operationId of operationsServingRow(SIDEKICK_SLATE_ROW)) {
      expect(GROWTH_OPERATIONS[operationId].expectedWireMethod, operationId).toBe(
        wireMethodFoldedFrom(operationId, "sidekick"),
      );
    }
  });

  it("names five distinct methods, so no two operations reach one wire", () => {
    const methods = operationsServingRow(SIDEKICK_SLATE_ROW).map(
      (operationId) => GROWTH_OPERATIONS[operationId].expectedWireMethod,
    );

    expect(new Set(methods).size).toBe(methods.length);
  });

  it("negative control: the same fold rejects an entry whose method is another's", () => {
    const mispaired = {
      ...GROWTH_OPERATIONS.sidekickDefinitionUpdate,
      expectedWireMethod: GROWTH_OPERATIONS.sidekickDefinitionDelete.expectedWireMethod,
    };

    expect(mispaired.expectedWireMethod).not.toBe(wireMethodFoldedFrom(mispaired.id, "sidekick"));
  });

  it("carries the peer-invocation pair, which is per-session state and not a definition", () => {
    // Asserted by name rather than left to the count above, because WHICH fifth it is
    // was the open question: the row's other four are definition CRUD, and this one
    // sets a session's own grant. Its wire method folds from its id in exactly the
    // same shape as its four siblings', which is what says it belongs to this row
    // rather than beside it.
    const foldedIds = operationsServingRow(SIDEKICK_SLATE_ROW).map((operationId) =>
      wireMethodFoldedFrom(operationId, "sidekick"),
    );

    expect(foldedIds).toContain("sidekick.peerInvocationSet");
  });
});

describe("the growth ledger's session-cost row — two reads of one fold", () => {
  const COST_SLATE_ROW: GrowthSlateRowId = "cost-receipt-read";

  it("attributes two operations to the row, both RPC methods on one registered root", () => {
    const costOperationIds = operationsServingRow(COST_SLATE_ROW);

    // Two of the plan's sixteen registered pairs. Stated rather than derived
    // because it is the claim: the console reads the fold and never writes it, so
    // the budget UPDATE and every other pair on that root are deliberately absent,
    // and a third operation appearing here is the drift worth failing on.
    expect(costOperationIds).toHaveLength(2);
    for (const operationId of costOperationIds) {
      expect(GROWTH_OPERATIONS[operationId].kind, operationId).toBe("method");
    }
  });

  it("names the registered method its own id folds to, so no entry is mispaired", () => {
    for (const operationId of operationsServingRow(COST_SLATE_ROW)) {
      expect(GROWTH_OPERATIONS[operationId].expectedWireMethod, operationId).toBe(
        wireMethodFoldedFrom(operationId, "orchestration"),
      );
    }
  });

  it("names no write verb, the console reading this plane and never moving it", () => {
    // The omission is the decision, so it is asserted rather than left to the count
    // above: `orchestration.budgetUpdate` is a registered method on the same root
    // and its absence from the ledger is what says the console meant to leave it.
    const methods = operationsServingRow(COST_SLATE_ROW).map(
      (operationId) => GROWTH_OPERATIONS[operationId].expectedWireMethod,
    );

    expect(methods).not.toContain("orchestration.budgetUpdate");
    expect(new Set(methods).size).toBe(methods.length);
  });
});

describe("the growth ledger's hydrated-event row — a projection with no namespace", () => {
  it("carries one operation, and it names no wire method", () => {
    // The read is built daemon-side and reaches no bridge namespace, so it is in
    // the same position as the two identity-and-registry rows below rather than in
    // the workflow block's: an invented method string would be a wire fact
    // traceable to nothing.
    const operationIds = operationsServingRow("hydrated-event-read");

    expect(operationIds).toStrictEqual(["hydratedEventRead"]);
    expect(GROWTH_OPERATIONS.hydratedEventRead.expectedWireMethod).toBeUndefined();
    expect(GROWTH_OPERATIONS.hydratedEventRead.kind).toBe("method");
  });
});

describe("the growth ledger's two identity-and-registry rows — no method to name", () => {
  it("carries one operation each, and neither names a wire method", () => {
    // The counterpart of the workflow and sidekick blocks, and the reason those
    // blocks' `toBe` assertions are meaningful: an entry names a method only where
    // its row's registry exists. Neither of these has one — the corpus resolves a
    // caller's principal daemon-side and never returns it, and the callback-tool
    // registry rides spawn with no read seam — so an invented string here would be
    // a wire fact traceable to nothing.
    for (const slateRow of [
      "caller-participant-identity",
      "callback-tool-registry-read",
    ] as const) {
      const operationIds = operationsServingRow(slateRow);

      expect(operationIds, slateRow).toHaveLength(1);
      // Read through the loop rather than by index: a row that lost its operation
      // makes the length assertion above fail, and indexing an empty result would
      // otherwise decide the case a second time on a value that is not there.
      for (const operationId of operationIds) {
        expect(GROWTH_OPERATIONS[operationId].expectedWireMethod, operationId).toBeUndefined();
        expect(GROWTH_OPERATIONS[operationId].kind, operationId).toBe("method");
      }
    }
  });
});

describe("the composed ledger — thirteen planes, one key space", () => {
  /** Every key that appears in more than one plane, in the order planes are spread. */
  function keysCarriedByTwoPlanes(
    planes: readonly Readonly<Record<string, unknown>>[],
  ): readonly string[] {
    const seen = new Set<string>();
    const duplicated: string[] = [];
    for (const plane of planes) {
      for (const key of Object.keys(plane)) {
        if (seen.has(key)) {
          duplicated.push(key);
        }
        seen.add(key);
      }
    }
    return duplicated;
  }

  it("carries every id in exactly one plane", () => {
    expect(keysCarriedByTwoPlanes(GROWTH_OPERATION_PLANES)).toStrictEqual([]);
  });

  it("negative control: the same walk names a row copied into a second plane", () => {
    // Without this the case above would pass for a walk that never reported
    // anything, and the property it is here for is precisely one the compiler
    // stopped catching when the single object literal became a spread of planes.
    expect(
      keysCarriedByTwoPlanes([
        { sessionRead: GROWTH_OPERATIONS.sessionRead },
        { sessionSearch: GROWTH_OPERATIONS.sessionSearch },
        { sessionRead: GROWTH_OPERATIONS.sessionRead },
      ]),
    ).toStrictEqual(["sessionRead"]);
  });

  it("loses no row in the spread: the planes' sizes sum to the table's", () => {
    // The other half of the same property. Disjointness alone would hold for a plane
    // the composition forgot to spread; this fails if one is missing from either
    // list, and the two together pin the composition to the planes exactly.
    const planeRowCount = GROWTH_OPERATION_PLANES.reduce(
      (total, plane) => total + Object.keys(plane).length,
      0,
    );

    expect(planeRowCount).toBe(Object.keys(GROWTH_OPERATIONS).length);
  });

  it("names each entry with the key it is filed under, across every plane", () => {
    // The row constructor takes the id as an argument, so a row copied to start a
    // new one can carry its source's id under a new key — which every structural
    // check above reads through and none of them contradicts.
    for (const [operationId, entry] of Object.entries(GROWTH_OPERATIONS)) {
      expect(entry.id, operationId).toBe(operationId);
    }
  });
});
