// The machine's saved workflows as the fixture daemon holds them: each one's catalog row and its
// versions' documents. `run/records.ts` counts the runs each one made.

import type {
  WorkflowDefinitionId,
  WorkflowDocument,
  WorkflowNode,
  WorkflowNodeId,
  WorkflowVersionId,
} from "@ai-sidekicks/contracts/workflow/definition/document";
import type { WorkflowDefinitionSummary } from "@ai-sidekicks/contracts/workflow/definition/methods";

import { minutesAgo } from "./clock.js";

/** One saved workflow: its catalog row and its versions' documents, oldest first. */
export interface WorkflowDefinitionRecord {
  readonly summary: WorkflowDefinitionSummary;
  readonly versions: readonly {
    readonly versionId: WorkflowVersionId;
    readonly document: WorkflowDocument;
  }[];
}

/** A saved workflow's id: a UUID whose first group numbers the workflow. */
function definitionId(workflowNumber: number): WorkflowDefinitionId {
  return `${workflowNumber.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000` as WorkflowDefinitionId;
}

/**
 * The id of version `versionNumber` of `definition`: the definition's UUID with the version's
 * number in its last group, so a run names a version by its definition and number.
 */
export function workflowVersionIdOf(
  definition: WorkflowDefinitionId,
  versionNumber: number,
): WorkflowVersionId {
  return `${definition.slice(0, 24)}${versionNumber.toString(16).padStart(12, "0")}` as WorkflowVersionId;
}

/** The daily change notes workflow, run on a schedule. */
export const DIGEST: WorkflowDefinitionId = definitionId(1);
/** The release review workflow, run by hand. */
export const RELEASE: WorkflowDefinitionId = definitionId(2);
/** The notes digest workflow, run when the notes change. */
export const SUMMARIZE: WorkflowDefinitionId = definitionId(3);
/** The triage workflow, started from chat. */
export const TRIAGE: WorkflowDefinitionId = definitionId(4);
/** The folder sweep workflow, which calls `SWEEP_CHILD` once per file. */
export const SWEEP: WorkflowDefinitionId = definitionId(5);
/** The workflow the folder sweep calls for each file. */
export const SWEEP_CHILD: WorkflowDefinitionId = definitionId(6);

function node(id: string, kind: string, name: string, order: number): WorkflowNode {
  return { id: id as WorkflowNodeId, kind, kindVersion: 1, name, order, params: {} };
}

function chain(
  name: string,
  trigger: WorkflowNode,
  nodes: readonly WorkflowNode[],
  positions: readonly (readonly [number, number])[],
): WorkflowDocument {
  const ordered = [trigger, ...nodes];
  return {
    schemaVersion: "2",
    name,
    trigger,
    nodes: [...nodes],
    edges: nodes.map((target, index) => ({
      id: `edge-${String(index)}`,
      source: (ordered[index] ?? trigger).id,
      sourceHandle: "outputs/main/0",
      target: target.id,
      targetHandle: "inputs/main/0",
    })),
    layout: {
      nodes: Object.fromEntries(
        ordered.map((placed, index) => {
          const [x, y] = positions[index] ?? [index * 260, 0];
          return [placed.id, { x, y }];
        }),
      ),
    },
  };
}

const DIGEST_DOCUMENT = chain(
  "Daily change notes",
  node("schedule", "trigger.schedule", "Every weekday at 8:00", 0),
  [
    node("fetch", "developer.git", "Fetch PRs", 1),
    node("review", "agent.run", "Review one PR", 2),
    node("summary", "files.write", "Save the notes", 3),
  ],
  [
    [0, 0],
    [260, 0],
    [520, 0],
    [780, 0],
  ],
);

// No layout: the page lays this one out itself.
const RELEASE_DOCUMENT: WorkflowDocument = (() => {
  const { layout: _layout, ...withoutLayout } = chain(
    "Release review",
    node("manual", "trigger.manual", "Run now", 0),
    [
      node("build", "developer.shell", "Build the release", 1),
      node("notes", "human.form", "Release notes", 2),
      node("approve", "human.approval", "Approve release", 3),
      node("publish", "developer.shell", "Publish", 4),
    ],
    [],
  );
  return withoutLayout;
})();

const SUMMARIZE_DOCUMENT = chain(
  "Notes digest",
  node("watch", "trigger.fileWatch", "When notes change", 0),
  [node("read", "files.read", "Read the notes", 1), node("summary", "agent.run", "Summarize", 2)],
  [
    [0, 0],
    [260, 80],
    [520, 0],
  ],
);

const TRIAGE_DOCUMENT = chain(
  "Triage issues",
  node("chat", "trigger.chat", "When asked in chat", 0),
  [
    node("ask", "human.waitForChatReply", "Ask for the label", 1),
    node("label", "agent.run", "Label the issues", 2),
  ],
  [
    [0, 0],
    [260, 0],
    [520, 0],
  ],
);

const SWEEP_DOCUMENT = chain(
  "Folder sweep",
  node("manual", "trigger.manual", "Run now", 0),
  [node("each", "flow.executeWorkflow", "Summarize each file", 1)],
  [
    [0, 0],
    [260, 0],
  ],
);

const SWEEP_CHILD_DOCUMENT = chain(
  "Summarize one file",
  node("called", "trigger.subWorkflow", "When Folder sweep calls it", 0),
  [node("summary", "agent.run", "Summarize the file", 1)],
  [
    [0, 0],
    [260, 0],
  ],
);

function summary(
  id: WorkflowDefinitionId,
  name: string,
  latestVersionNumber: number,
  triggerKind: string,
): SavedWorkflowSummary {
  return {
    id,
    name,
    latestVersionNumber,
    latestWorkflowVersionId: workflowVersionIdOf(id, latestVersionNumber),
    contentHash: `b3:${id.slice(0, 8)}`,
    triggerKind,
    enabled: true,
    tags: [],
    createdAt: minutesAgo(60 * 24 * 30),
    updatedAt: minutesAgo(60 * 24),
  };
}

/** A saved workflow's catalog row before its runs are counted. */
type SavedWorkflowSummary = Omit<WorkflowDefinitionSummary, "runCount">;

/**
 * The saved workflows and their versions, counted into `WORKFLOW_DEFINITION_RECORDS` in
 * `run/records.ts`.
 */
export const SAVED_WORKFLOWS: readonly (Omit<WorkflowDefinitionRecord, "summary"> & {
  readonly summary: SavedWorkflowSummary;
})[] = [
  {
    summary: summary(DIGEST, "Daily change notes", 3, "trigger.schedule"),
    versions: [1, 2, 3].map((number) => ({
      versionId: workflowVersionIdOf(DIGEST, number),
      document: DIGEST_DOCUMENT,
    })),
  },
  {
    summary: summary(RELEASE, "Release review", 2, "trigger.manual"),
    versions: [1, 2].map((number) => ({
      versionId: workflowVersionIdOf(RELEASE, number),
      document: RELEASE_DOCUMENT,
    })),
  },
  {
    summary: summary(SUMMARIZE, "Notes digest", 1, "trigger.fileWatch"),
    versions: [{ versionId: workflowVersionIdOf(SUMMARIZE, 1), document: SUMMARIZE_DOCUMENT }],
  },
  {
    summary: summary(TRIAGE, "Triage issues", 1, "trigger.chat"),
    versions: [{ versionId: workflowVersionIdOf(TRIAGE, 1), document: TRIAGE_DOCUMENT }],
  },
  {
    summary: summary(SWEEP, "Folder sweep", 1, "trigger.manual"),
    versions: [{ versionId: workflowVersionIdOf(SWEEP, 1), document: SWEEP_DOCUMENT }],
  },
  {
    summary: summary(SWEEP_CHILD, "Summarize one file", 1, "trigger.subWorkflow"),
    versions: [{ versionId: workflowVersionIdOf(SWEEP_CHILD, 1), document: SWEEP_CHILD_DOCUMENT }],
  },
];
