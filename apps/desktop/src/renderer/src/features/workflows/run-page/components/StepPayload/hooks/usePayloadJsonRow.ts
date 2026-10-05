import { useMemo } from "react";

import type { WorkflowItem } from "@ai-sidekicks/contracts/workflow/definition/definition";

import { payloadJsonRow } from "../payload-rows.js";

/** One JSON view row's text, stringified once while the row stays drawn. */
export function usePayloadJsonRow(items: readonly WorkflowItem[], rowIndex: number): string {
  return useMemo(() => payloadJsonRow(items, rowIndex), [items, rowIndex]);
}
