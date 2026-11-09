// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The attachments a message carries: artifact ids in the order they were staged.

import type { SchemaCheck } from "../../schema-check.js";
import type { ArtifactId } from "./id.js";

/**
 * A message's attachments: artifact ids, kept in the order the sender staged them. How many a
 * message carries is what the daemon and the provider accept, never a count of the app's own.
 */
export type AttachmentReferenceList = ArtifactId[];

// prettier-ignore
const pattern4 = new RegExp("^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$", "u");
// prettier-ignore
function validate196(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is AttachmentReferenceList {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate196.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(Array.isArray(data)){var valid0: any = true;const len0: any = data.length;for(let i0=0; i0<len0; i0++){let data0: any = data[i0];const _errs1: any = errors;const _errs2: any = errors;if(errors === _errs2){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate196.errors = [{instancePath:instancePath+"/" + i0,schemaPath:"sidekicks-contracts:artifacts/id#/$defs/ArtifactId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate196.errors = [{instancePath:instancePath+"/" + i0,schemaPath:"sidekicks-contracts:artifacts/id#/$defs/ArtifactId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs1 === errors;if(!valid0){break;}}}else {validate196.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "array"}}];return false;}}validate196.errors = vErrors;return errors === 0;}
// prettier-ignore
validate196.errors = null as any[] | null;
// prettier-ignore
validate196.evaluated = {"items":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link AttachmentReferenceList}. */
export const validateAttachmentReferenceList: SchemaCheck<AttachmentReferenceList> = validate196;
