// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The usage-limit signal and the spent-retries signal a driver hands over with a turn's end, which a failed run's cause carries.

import type { SchemaCheck } from "../../../schema-check.js";
import type { WireInstant } from "../../internal/wire-scalars.js";
import type { CredentialGeneration, ProviderAccountId } from "../account/record.js";

/** Every usage-limit cause. */
export const PROVIDER_USAGE_LIMIT_CAUSES = ["planAllowanceExhausted"] as const;

/**
 * Why a provider refused for spend, on an axis apart from the recovery condition. Only the plan's
 * allowance for a rolling window clears on its own; a spent credit balance, a payment fault or a
 * spending ceiling needs a person, so such a turn ends on the driver's ordinary failure path.
 */
export type ProviderUsageLimitCause = "planAllowanceExhausted";

/**
 * The instant the provider named for the spent window to reset.
 */
export interface ProviderUsageLimitResetBoundary {
  /**
   * When the window resets.
   */
  resetsAt: WireInstant;
}
/**
 * A recognized usage-limit refusal, on the account and credential generation of the conversation
 * that met it. A missing boundary means no reset instant was seen, so no resume is scheduled; it
 * does not mean the provider publishes none.
 */
export interface ProviderUsageLimitSignal {
  /**
   * Why the provider refused.
   */
  cause: ProviderUsageLimitCause;
  /**
   * The account whose allowance is spent: the one the conversation ran on.
   */
  providerAccountId: ProviderAccountId;
  /**
   * The account's credential generation when the limit was met, so a signal from before a
   * sign-in again reads as stale.
   */
  credentialGeneration: CredentialGeneration;
  /**
   * When the spent window resets, where the provider named it.
   */
  resetBoundary?: ProviderUsageLimitResetBoundary;
}
/**
 * A turn that ended because the provider's own retries ran out: the provider did not answer.
 * Nothing clears on its own, so no reset boundary rides it.
 */
export interface ProviderSpentRetriesSignal {
  /**
   * Always `retriesExhausted`.
   */
  cause: "retriesExhausted";
}

// prettier-ignore
const schema2882: any = {"description":"Why a provider refused for spend, on an axis apart from the recovery condition. Only the plan's\nallowance for a rolling window clears on its own; a spent credit balance, a payment fault or a\nspending ceiling needs a person, so such a turn ends on the driver's ordinary failure path.","type":"string","enum":["planAllowanceExhausted"]};
// prettier-ignore
function validate1532(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ProviderUsageLimitCause {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1532.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(typeof data !== "string"){validate1532.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}if(!(data === "planAllowanceExhausted")){validate1532.errors = [{instancePath,schemaPath:"#/enum",keyword:"enum",params:{allowedValues: schema2882.enum}}];return false;}validate1532.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1532.errors = null as any[] | null;
// prettier-ignore
validate1532.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const pattern5 = new RegExp("^(?:(?:[0-9][0-9][2468][048]|[0-9][0-9][13579][26]|[0-9][0-9]0[48]|[02468][048]00|[13579][26]00)-02-29|[0-9]{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12][0-9]|3[01])|(?:0[469]|11)-(?:0[1-9]|[12][0-9]|30)|(?:02)-(?:0[1-9]|1[0-9]|2[0-8])))T(?:(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]+)?(?:Z|([+-](?:[01][0-9]|2[0-3]):[0-5][0-9])))$", "u");
// prettier-ignore
function validate1533(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ProviderUsageLimitResetBoundary {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1533.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.resetsAt === undefined) && (missing0 = "resetsAt")){validate1533.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "resetsAt")){validate1533.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.resetsAt !== undefined){let data0: any = data.resetsAt;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern5.test(data0)){validate1533.errors = [{instancePath:instancePath+"/resetsAt",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant/pattern",keyword:"pattern",params:{pattern: "^(?:(?:[0-9][0-9][2468][048]|[0-9][0-9][13579][26]|[0-9][0-9]0[48]|[02468][048]00|[13579][26]00)-02-29|[0-9]{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12][0-9]|3[01])|(?:0[469]|11)-(?:0[1-9]|[12][0-9]|30)|(?:02)-(?:0[1-9]|1[0-9]|2[0-8])))T(?:(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]+)?(?:Z|([+-](?:[01][0-9]|2[0-3]):[0-5][0-9])))$"}}];return false;}}else {validate1533.errors = [{instancePath:instancePath+"/resetsAt",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant/type",keyword:"type",params:{type: "string"}}];return false;}}}}}}else {validate1533.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1533.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1533.errors = null as any[] | null;
// prettier-ignore
validate1533.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link ProviderUsageLimitCause}. */
export const validateProviderUsageLimitCause: SchemaCheck<ProviderUsageLimitCause> = validate1532;
/** Checks that a value is a {@link ProviderUsageLimitResetBoundary}. */
export const validateProviderUsageLimitResetBoundary: SchemaCheck<ProviderUsageLimitResetBoundary> =
  validate1533;
