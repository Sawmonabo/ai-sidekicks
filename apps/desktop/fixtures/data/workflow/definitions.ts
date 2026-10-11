// The machine's saved workflows as the fixture daemon holds them: each one's catalog row and its
// versions' documents. `run/records.ts` counts the runs each one made.

import type {
  WorkflowDefinitionId,
  WorkflowDocument,
  WorkflowNode,
  WorkflowNodeId,
} from "@ai-sidekicks/contracts/workflow/definition/document";
import type { WorkflowDefinitionSummary } from "@ai-sidekicks/contracts/workflow/definition/methods";

import { minutesAgo } from "./clock.js";

/** One saved workflow: its catalog row and its versions' documents, oldest first. */
export interface WorkflowDefinitionRecord {
  readonly summary: WorkflowDefinitionSummary;
  readonly versions: readonly { readonly versionId: string; readonly document: WorkflowDocument }[];
}

/** The daily change notes workflow, run on a schedule. */
export const DIGEST = "wf-morning-digest" as WorkflowDefinitionId;
/** The release review workflow, run by hand. */
export const RELEASE = "wf-release-review" as WorkflowDefinitionId;
/** The notes digest workflow, run when the notes change. */
export const SUMMARIZE = "wf-summarize-folder" as WorkflowDefinitionId;
/** The triage workflow, started from chat. */
export const TRIAGE = "wf-triage-issues" as WorkflowDefinitionId;
/** The folder sweep workflow, which calls `SWEEP_CHILD` once per file. */
export const SWEEP = "wf-folder-sweep" as WorkflowDefinitionId;
/** The workflow the folder sweep calls for each file. */
export const SWEEP_CHILD = "wf-summarize-one-file" as WorkflowDefinitionId;

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
  node("watch", "trigger.file-watch", "When notes change", 0),
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
    node("ask", "human.wait-for-chat-reply", "Ask for the label", 1),
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
  [node("each", "flow.execute-workflow", "Summarize each file", 1)],
  [
    [0, 0],
    [260, 0],
  ],
);

const SWEEP_CHILD_DOCUMENT = chain(
  "Summarize one file",
  node("called", "trigger.sub-workflow", "When Folder sweep calls it", 0),
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
    latestWorkflowVersionId: `${id}-v${String(latestVersionNumber)}`,
    contentHash: `b3:${id.slice(3, 11)}`,
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
      versionId: `${DIGEST}-v${String(number)}`,
      document: DIGEST_DOCUMENT,
    })),
  },
  {
    summary: summary(RELEASE, "Release review", 2, "trigger.manual"),
    versions: [1, 2].map((number) => ({
      versionId: `${RELEASE}-v${String(number)}`,
      document: RELEASE_DOCUMENT,
    })),
  },
  {
    summary: summary(SUMMARIZE, "Notes digest", 1, "trigger.file-watch"),
    versions: [{ versionId: `${SUMMARIZE}-v1`, document: SUMMARIZE_DOCUMENT }],
  },
  {
    summary: summary(TRIAGE, "Triage issues", 1, "trigger.chat"),
    versions: [{ versionId: `${TRIAGE}-v1`, document: TRIAGE_DOCUMENT }],
  },
  {
    summary: summary(SWEEP, "Folder sweep", 1, "trigger.manual"),
    versions: [{ versionId: `${SWEEP}-v1`, document: SWEEP_DOCUMENT }],
  },
  {
    summary: summary(SWEEP_CHILD, "Summarize one file", 1, "trigger.sub-workflow"),
    versions: [{ versionId: `${SWEEP_CHILD}-v1`, document: SWEEP_CHILD_DOCUMENT }],
  },
];
