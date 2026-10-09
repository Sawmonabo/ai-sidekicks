// The plan record a plan turn ends with, `plan.proposed`, built the same way from Claude Code's
// held plan-exit request and Codex's plan item: the plan's own text, its first heading as the
// title, and the daemon's reading of its top-level steps and the files it names.

import type { PlanProposedPayload } from "@ai-sidekicks/contracts/plan";
import { PlanIdSchema } from "@ai-sidekicks/contracts/plan";
import type { RunId } from "@ai-sidekicks/contracts/run/id";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import type { List, Nodes, Root } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { toString } from "mdast-util-to-string";

import { mintUuidV7 } from "../../uuid-v7.js";

/** What a plan record is made from: the plan as the provider sent it, never read off the disk. */
export interface PlanRecordSource {
  readonly sessionId: SessionId;
  readonly runId: RunId;
  readonly text: string;
  /** Where the provider wrote the plan as a file, where it did. */
  readonly planFilePath?: string | undefined;
}

// A path a plan names: no spaces and no scheme, with a folder or a file extension.
const FILE_PATH_PATTERN = /^(?![a-z][a-z0-9+.-]*:\/\/)[^\s]*(?:\/[^\s]*|\.[A-Za-z0-9]{1,8})$/;

/** The `plan.proposed` payload for one plan, under a freshly minted plan id. */
export function composePlanProposedPayload(source: PlanRecordSource): PlanProposedPayload {
  const tree = fromMarkdown(source.text);
  return {
    planId: PlanIdSchema.parse(mintUuidV7()),
    sessionId: source.sessionId,
    runId: source.runId,
    title: readPlanTitle(tree, source.text),
    text: source.text,
    stepCount: countTopLevelSteps(tree),
    fileCount: countNamedFiles(tree),
    ...(source.planFilePath === undefined ? {} : { planFilePath: source.planFilePath }),
  };
}

// The first heading's words, else the plan's first line.
function readPlanTitle(tree: Root, text: string): string {
  const heading = tree.children.find((node) => node.type === "heading");
  const title = heading === undefined ? undefined : toString(heading).trim();
  return title !== undefined && title !== ""
    ? title
    : (text
        .split("\n")
        .find((line) => line.trim() !== "")
        ?.trim() ?? "");
}

// The items of the plan's own lists, not those nested in one; numbered lists alone where it has
// any, since bullets beside numbered steps are notes.
function countTopLevelSteps(tree: Root): number {
  const lists = tree.children.filter((node): node is List => node.type === "list");
  const numbered = lists.filter((list) => list.ordered === true);
  return (numbered.length > 0 ? numbered : lists).reduce(
    (count, list) => count + list.children.length,
    0,
  );
}

// The distinct paths the plan names in code spans and links.
function countNamedFiles(tree: Root): number {
  const paths = new Set<string>();
  const visit = (node: Nodes): void => {
    const candidate =
      node.type === "inlineCode" ? node.value : node.type === "link" ? node.url : undefined;
    if (candidate !== undefined && FILE_PATH_PATTERN.test(candidate.trim())) {
      paths.add(candidate.trim());
    }
    if ("children" in node) {
      for (const child of node.children) {
        visit(child);
      }
    }
  };
  visit(tree);
  return paths.size;
}
