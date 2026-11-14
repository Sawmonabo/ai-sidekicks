// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The usage-limit signal and the spent-retries signal a driver hands over with a turn's end, which a failed run's cause carries.

import type { CompiledSchemaCheck } from "../../../schema-check.js";
import { type WireInstant, validateWireInstant } from "../../internal/wire-scalars.js";
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
const schema994: any = {"description":"Why a provider refused for spend, on an axis apart from the recovery condition. Only the plan's\nallowance for a rolling window clears on its own; a spent credit balance, a payment fault or a\nspending ceiling needs a person, so such a turn ends on the driver's ordinary failure path.","type":"string","enum":["planAllowanceExhausted"]};
/** Checks that a value is a {@link ProviderUsageLimitCause}. */
// prettier-ignore
export const validateProviderUsageLimitCause: CompiledSchemaCheck<ProviderUsageLimitCause> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ProviderUsageLimitCause {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateProviderUsageLimitCause.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(typeof data !== "string"){validateProviderUsageLimitCause.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}if(!(data === "planAllowanceExhausted")){validateProviderUsageLimitCause.errors = [{instancePath,schemaPath:"#/enum",keyword:"enum",params:{allowedValues: schema994.enum}}];return false;}validateProviderUsageLimitCause.errors = vErrors;return errors === 0;};
// prettier-ignore
validateProviderUsageLimitCause.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link ProviderUsageLimitResetBoundary}. */
// prettier-ignore
export const validateProviderUsageLimitResetBoundary: CompiledSchemaCheck<ProviderUsageLimitResetBoundary> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ProviderUsageLimitResetBoundary {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateProviderUsageLimitResetBoundary.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.resetsAt === undefined) && (missing0 = "resetsAt")){validateProviderUsageLimitResetBoundary.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "resetsAt")){validateProviderUsageLimitResetBoundary.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.resetsAt !== undefined){if(!(validateWireInstant.call(this, data.resetsAt, {instancePath:instancePath+"/resetsAt",parentData:data,parentDataProperty:"resetsAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}}}}}else {validateProviderUsageLimitResetBoundary.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateProviderUsageLimitResetBoundary.errors = vErrors;return errors === 0;};
// prettier-ignore
validateProviderUsageLimitResetBoundary.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
