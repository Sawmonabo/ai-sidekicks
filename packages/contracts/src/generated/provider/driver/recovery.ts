// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// Why a run needs recovery: the axis a resume failure and a run's state change carry.

import type { SchemaCheck } from "../../../schema-check.js";

/** Every recovery condition. */
export const RECOVERY_CONDITIONS = ["recoveryNeeded", "reauthRequired"] as const;

/**
 * Why a run needs attention.
 */
export type RecoveryCondition = "recoveryNeeded" | "reauthRequired";

// prettier-ignore
const schema696: any = {"description":"Why a run needs attention.","type":"string","enum":["recoveryNeeded","reauthRequired"]};
// prettier-ignore
function validate1528(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is RecoveryCondition {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1528.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(typeof data !== "string"){validate1528.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}if(!((data === "recoveryNeeded") || (data === "reauthRequired"))){validate1528.errors = [{instancePath,schemaPath:"#/enum",keyword:"enum",params:{allowedValues: schema696.enum}}];return false;}validate1528.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1528.errors = null as any[] | null;
// prettier-ignore
validate1528.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link RecoveryCondition}. */
export const validateRecoveryCondition: SchemaCheck<RecoveryCondition> = validate1528;
