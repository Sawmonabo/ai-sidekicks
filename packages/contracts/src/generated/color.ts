// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// A color as the wire carries it: sRGB written `#rrggbb`, either case.

import type { SchemaCheck } from "../schema-check.js";

/** The pattern every color field checks, as text: an sRGB color written `#rrggbb`, either case. */
export const HEX_COLOR_PATTERN = "^#[0-9a-fA-F]{6}$" as const;

/**
 * An sRGB color written `#rrggbb`, either case.
 */
export type HexColor = string;

// prettier-ignore
const pattern353 = new RegExp("^#[0-9a-fA-F]{6}$", "u");
// prettier-ignore
function validate293(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is HexColor {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate293.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(typeof data === "string"){if(!pattern353.test(data)){validate293.errors = [{instancePath,schemaPath:"#/pattern",keyword:"pattern",params:{pattern: "^#[0-9a-fA-F]{6}$"}}];return false;}}else {validate293.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}}validate293.errors = vErrors;return errors === 0;}
// prettier-ignore
validate293.errors = null as any[] | null;
// prettier-ignore
validate293.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link HexColor}. */
export const validateHexColor: SchemaCheck<HexColor> = validate293;
