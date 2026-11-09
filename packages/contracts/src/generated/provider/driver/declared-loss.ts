/* eslint-disable */
// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// What a transcript operation could not carry, named so a client shows the loss rather than a silent gap.

import type { SchemaCheck } from "../../../schema-check.js";

/** Every declared loss kind. */
export const DECLARED_LOSS_KINDS = [
  "providerPrivateReasoning",
  "contextTruncated",
  "toolCallHistoryRepaired",
  "conversationHistorySummarized",
  "helperConversations",
  "toolOutputBodies",
  "liveToolCalls",
  "providerSkillAndCommandNames",
  "turnContentUnavailable",
] as const;

/**
 * One thing a transcript operation could not carry. A new kind is a deliberate addition; an empty
 * list claims nothing was dropped, so a driver that does not know what it lost may not send one.
 */
export type DeclaredLossKind =
  | "providerPrivateReasoning"
  | "contextTruncated"
  | "toolCallHistoryRepaired"
  | "conversationHistorySummarized"
  | "helperConversations"
  | "toolOutputBodies"
  | "liveToolCalls"
  | "providerSkillAndCommandNames"
  | "turnContentUnavailable";

// prettier-ignore
const schema180: any = {"description":"One thing a transcript operation could not carry. A new kind is a deliberate addition; an empty\nlist claims nothing was dropped, so a driver that does not know what it lost may not send one.","type":"string","enum":["providerPrivateReasoning","contextTruncated","toolCallHistoryRepaired","conversationHistorySummarized","helperConversations","toolOutputBodies","liveToolCalls","providerSkillAndCommandNames","turnContentUnavailable"]};
// prettier-ignore
function validate1515(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is DeclaredLossKind {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1515.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(typeof data !== "string"){validate1515.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}if(!(((((((((data === "providerPrivateReasoning") || (data === "contextTruncated")) || (data === "toolCallHistoryRepaired")) || (data === "conversationHistorySummarized")) || (data === "helperConversations")) || (data === "toolOutputBodies")) || (data === "liveToolCalls")) || (data === "providerSkillAndCommandNames")) || (data === "turnContentUnavailable"))){validate1515.errors = [{instancePath,schemaPath:"#/enum",keyword:"enum",params:{allowedValues: schema180.enum}}];return false;}validate1515.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1515.errors = null as any[] | null;
// prettier-ignore
validate1515.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link DeclaredLossKind}. */
export const validateDeclaredLossKind: SchemaCheck<DeclaredLossKind> = validate1515;
