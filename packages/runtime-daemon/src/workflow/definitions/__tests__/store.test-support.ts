// A workflow library over a scratch database with the daemon's schema, and a small valid document
// to save into it.
import type { DeviceId } from "@ai-sidekicks/contracts/trust-statement";
import type {
  WorkflowDefinitionId,
  WorkflowDocument,
  WorkflowNodeId,
} from "@ai-sidekicks/contracts/workflow/definition/document";

import {
  openScratchDatabase,
  type ScratchDatabase,
} from "../../../database/__fixtures__/scratch.js";
import { WorkflowDraftStore } from "../drafts.js";
import { WorkflowLibrary } from "../library.js";
import { WorkflowDefinitionStore, type WorkflowSaveAuthor } from "../store.js";

/** The person saving from the builder on this machine. */
export const BUILDER_AUTHOR: WorkflowSaveAuthor = { deviceId: "device-local" as DeviceId };

/**
 * A trigger wired to one step. `readPath` is the step's one param, so two calls with different
 * paths give two different hashed bodies.
 */
export function buildWorkflowDocument(name: string, readPath = "notes.md"): WorkflowDocument {
  return {
    schemaVersion: "2",
    name,
    trigger: {
      id: "trigger" as WorkflowNodeId,
      kind: "trigger.manual",
      kindVersion: 1,
      name: "Start",
      order: 0,
      params: {},
    },
    nodes: [
      {
        id: "read" as WorkflowNodeId,
        kind: "files.read",
        kindVersion: 1,
        name: "Read notes",
        order: 0,
        params: { path: readPath },
      },
    ],
    edges: [
      {
        id: "trigger-to-read",
        source: "trigger" as WorkflowNodeId,
        sourceHandle: "outputs/main/0",
        target: "read" as WorkflowNodeId,
        targetHandle: "inputs/main/0",
      },
    ],
  };
}

/** The library's reads and writes and the builder's drafts over one scratch database. */
export interface WorkflowLibraryFixture {
  readonly scratch: ScratchDatabase;
  readonly library: WorkflowLibrary;
  readonly store: WorkflowDefinitionStore;
  readonly drafts: WorkflowDraftStore;
  /** How many versions the workflow has, or with no id how many every workflow has together. */
  readonly countVersions: (definitionId?: WorkflowDefinitionId) => number;
  /** How many workflows exist, deleted ones included. */
  readonly countDefinitions: () => number;
  readonly close: () => Promise<void>;
}

/**
 * Opens a fresh library. Every node kind is unknown to its graph check, so a document is checked
 * for its shape alone.
 */
export async function openWorkflowLibraryFixture(): Promise<WorkflowLibraryFixture> {
  const scratch = await openScratchDatabase();
  const library = new WorkflowLibrary(scratch);
  const versionCount = scratch.reader.prepare<[string | null, string | null], { count: number }>(
    "SELECT COUNT(*) AS count FROM workflow_versions WHERE ? IS NULL OR definition_id = ?",
  );
  const definitionCount = scratch.reader.prepare<[], { count: number }>(
    "SELECT COUNT(*) AS count FROM workflow_definitions",
  );
  return {
    scratch,
    library,
    store: new WorkflowDefinitionStore(scratch, library, () => undefined),
    drafts: new WorkflowDraftStore(scratch),
    countVersions: (definitionId) =>
      versionCount.get(definitionId ?? null, definitionId ?? null)?.count ?? 0,
    countDefinitions: () => definitionCount.get()?.count ?? 0,
    close: () => scratch.close(),
  };
}
