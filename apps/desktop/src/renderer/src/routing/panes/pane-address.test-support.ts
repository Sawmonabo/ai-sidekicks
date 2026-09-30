// The entity references and the refusal reader both pane-address suites build cases from.

import { isRefusal } from "@renderer/lib/refusal.js";
import type { EntityRef } from "@renderer/lib/entity-kinds.js";
import { parsePaneAddress } from "./parse-pane-address.js";

/**
 * An `EntityRef` whose kind is pinned to one literal. An intersection rather than `Extract`,
 * because `EntityRef.kind` is the whole union and extracting from it yields `never`.
 */
type EntityRefOf<TKind extends EntityRef["kind"]> = EntityRef & {
  readonly kind: TKind;
};

/** An agent reference. */
export const AGENT: EntityRefOf<"agent"> = { kind: "agent", id: "agent-1" };
/** A run reference. */
export const RUN: EntityRefOf<"run"> = { kind: "run", id: "run-1" };
/** An artifact reference. */
export const ARTIFACT: EntityRefOf<"artifact"> = { kind: "artifact", id: "artifact-1" };
/** A workflow-run reference. */
export const WORKFLOW_RUN: EntityRefOf<"workflow-run"> = {
  kind: "workflow-run",
  id: "workflow-run-1",
};
/** An entity kind that is registered but that no pane kind is a view of. */
export const BROWSER_PAGE: EntityRefOf<"browser-page"> = { kind: "browser-page", id: "page-1" };

/** The refusal a parse answered with, or a failure naming what it admitted instead. */
export function refusalFrom(outcome: ReturnType<typeof parsePaneAddress>): {
  readonly code: string;
  readonly detail: string;
  readonly origin: string;
} {
  if (!isRefusal(outcome)) {
    throw new Error(`the parse admitted a "${outcome.kind}" address it should have refused`);
  }
  return outcome;
}
