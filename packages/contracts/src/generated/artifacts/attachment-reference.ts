// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The attachments a message carries: artifact ids in the order they were staged.

import type { CompiledSchemaCheck } from "../../schema-check.js";
import { type ArtifactId, validateArtifactId } from "./id.js";

/**
 * A message's attachments: artifact ids, kept in the order the sender staged them. How many a
 * message carries is what the daemon and the provider accept, never a count of the app's own.
 */
export type AttachmentReferenceList = ArtifactId[];

/** Checks that a value is a {@link AttachmentReferenceList}. */
// prettier-ignore
export const validateAttachmentReferenceList: CompiledSchemaCheck<AttachmentReferenceList> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is AttachmentReferenceList {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateAttachmentReferenceList.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(Array.isArray(data)){var valid0: any = true;const len0: any = data.length;for(let i0=0; i0<len0; i0++){const _errs1: any = errors;if(!(validateArtifactId.call(this, data[i0], {instancePath:instancePath+"/" + i0,parentData:data,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateArtifactId.errors : vErrors.concat(validateArtifactId.errors);errors = vErrors.length;}var valid0: any = _errs1 === errors;if(!valid0){break;}}}else {validateAttachmentReferenceList.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "array"}}];return false;}}validateAttachmentReferenceList.errors = vErrors;return errors === 0;};
// prettier-ignore
validateAttachmentReferenceList.evaluated = {"items":true,"dynamicProps":false,"dynamicItems":false} as any;
