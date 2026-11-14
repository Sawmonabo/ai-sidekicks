// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// Why a run needs recovery: the axis a resume failure and a run's state change carry.

import type { CompiledSchemaCheck } from "../../../schema-check.js";

/** Every recovery condition. */
export const RECOVERY_CONDITIONS = ["recoveryNeeded", "reauthRequired"] as const;

/**
 * Why a run needs attention.
 */
export type RecoveryCondition = "recoveryNeeded" | "reauthRequired";

// prettier-ignore
const schema274: any = {"description":"Why a run needs attention.","type":"string","enum":["recoveryNeeded","reauthRequired"]};
/** Checks that a value is a {@link RecoveryCondition}. */
// prettier-ignore
export const validateRecoveryCondition: CompiledSchemaCheck<RecoveryCondition> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is RecoveryCondition {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateRecoveryCondition.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(typeof data !== "string"){validateRecoveryCondition.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}if(!((data === "recoveryNeeded") || (data === "reauthRequired"))){validateRecoveryCondition.errors = [{instancePath,schemaPath:"#/enum",keyword:"enum",params:{allowedValues: schema274.enum}}];return false;}validateRecoveryCondition.errors = vErrors;return errors === 0;};
// prettier-ignore
validateRecoveryCondition.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
