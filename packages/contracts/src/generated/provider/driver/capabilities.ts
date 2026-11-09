// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// What a driver offers a client: its models and modes, and the execution posture a run starts under.

import { type SchemaCheck, ucs2length } from "../../../schema-check.js";

/**
 * How a run may touch the machine, tagged on `mode`, the permission level: `readonly` and
 * `yolo` carry no writable roots, so only `ask`, `reviewed` and `sandboxed` name the folders a
 * run may write.
 */
export type ExecutionPosture =
  | {
      mode: "readonly";
      /**
       * The credential deny list handed to the provider on every level.
       */
      credentialPolicyRef: string;
      /**
       * Always empty.
       *
       * @maxItems 0
       */
      writableRoots: [];
    }
  | {
      mode: "ask";
      /**
       * The credential deny list handed to the provider on every level.
       */
      credentialPolicyRef: string;
      /**
       * The folders a run may write.
       */
      writableRoots: string[];
    }
  | {
      mode: "reviewed";
      /**
       * The credential deny list handed to the provider on every level.
       */
      credentialPolicyRef: string;
      /**
       * The folders a run may write.
       */
      writableRoots: string[];
    }
  | {
      mode: "sandboxed";
      /**
       * The credential deny list handed to the provider on every level.
       */
      credentialPolicyRef: string;
      /**
       * The folders a run may write.
       */
      writableRoots: string[];
    }
  | {
      mode: "yolo";
      /**
       * The credential deny list handed to the provider on every level.
       */
      credentialPolicyRef: string;
      /**
       * Always empty.
       *
       * @maxItems 0
       */
      writableRoots: [];
    };

/**
 * One selectable model of one provider, normalized at the driver's boundary. A model's default
 * row and its larger-window row share the model's id, so a row is found by its id and its
 * `largerWindow` together.
 */
export interface ProviderModel {
  /**
   * The model's id.
   */
  id: string;
  /**
   * The model's name.
   */
  name: string;
  /**
   * What the model can do, in the provider's words.
   */
  capabilities: string[];
  /**
   * The model's reasoning-effort levels, as the installed build offers them; absent means the
   * model has no effort axis, which an empty list would deny.
   */
  effortLevels?: string[];
  /**
   * The model's output-speed levels where its provider publishes them per model; absent means
   * the model exposes no speed selection.
   */
  outputSpeedLevels?: string[];
  /**
   * Whether the model has a fast output mode, as its provider reports it.
   */
  fast: boolean;
  /**
   * Whether this row is the model's larger window, offered beside its default row.
   */
  largerWindow: boolean;
  /**
   * The window in tokens as the provider reports it; absent until a reading arrives.
   */
  contextWindow?: number;
}
/**
 * One selectable mode of one provider, normalized at the driver's boundary.
 */
export interface ProviderMode {
  /**
   * The mode's id.
   */
  id: string;
  /**
   * The mode's name.
   */
  name: string;
}

// prettier-ignore
const func1 = ucs2length;
// prettier-ignore
const pattern6 = new RegExp("^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$", "u");
// prettier-ignore
const pattern43 = new RegExp("^[^\\x00]*$", "u");
// prettier-ignore
function validate1501(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ExecutionPosture {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1501.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let valid0: any = false;const tag0: any = data.mode;if(typeof tag0 == "string"){if(tag0 === "readonly"){const _errs2: any = errors;if(errors === _errs2){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.mode === undefined) && (missing0 = "mode")) || ((data.credentialPolicyRef === undefined) && (missing0 = "credentialPolicyRef"))) || ((data.writableRoots === undefined) && (missing0 = "writableRoots"))){validate1501.errors = [{instancePath,schemaPath:"#/oneOf/0/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs4: any = errors;for(const key0 in data){if(!(((key0 === "mode") || (key0 === "credentialPolicyRef")) || (key0 === "writableRoots"))){validate1501.errors = [{instancePath,schemaPath:"#/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs4 === errors){if(data.mode !== undefined){let data0: any = data.mode;const _errs5: any = errors;if(typeof data0 !== "string"){validate1501.errors = [{instancePath:instancePath+"/mode",schemaPath:"#/oneOf/0/properties/mode/type",keyword:"type",params:{type: "string"}}];return false;}if("readonly" !== data0){validate1501.errors = [{instancePath:instancePath+"/mode",schemaPath:"#/oneOf/0/properties/mode/const",keyword:"const",params:{allowedValue: "readonly"}}];return false;}var valid2: any = _errs5 === errors;}else {var valid2: any = true;}if(valid2){if(data.credentialPolicyRef !== undefined){let data1: any = data.credentialPolicyRef;const _errs7: any = errors;if(errors === _errs7){if(typeof data1 === "string"){if(func1(data1) > 256){validate1501.errors = [{instancePath:instancePath+"/credentialPolicyRef",schemaPath:"#/oneOf/0/properties/credentialPolicyRef/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data1) < 1){validate1501.errors = [{instancePath:instancePath+"/credentialPolicyRef",schemaPath:"#/oneOf/0/properties/credentialPolicyRef/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data1)){validate1501.errors = [{instancePath:instancePath+"/credentialPolicyRef",schemaPath:"#/oneOf/0/properties/credentialPolicyRef/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate1501.errors = [{instancePath:instancePath+"/credentialPolicyRef",schemaPath:"#/oneOf/0/properties/credentialPolicyRef/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs7 === errors;}else {var valid2: any = true;}if(valid2){if(data.writableRoots !== undefined){let data2: any = data.writableRoots;const _errs9: any = errors;if(errors === _errs9){if(Array.isArray(data2)){if(data2.length > 0){validate1501.errors = [{instancePath:instancePath+"/writableRoots",schemaPath:"#/oneOf/0/properties/writableRoots/maxItems",keyword:"maxItems",params:{limit: 0}}];return false;}else {var valid3: any = true;const len0: any = data2.length;for(let i0=0; i0<len0; i0++){let data3: any = data2[i0];const _errs11: any = errors;if(errors === _errs11){if(typeof data3 === "string"){if(func1(data3) > 4096){validate1501.errors = [{instancePath:instancePath+"/writableRoots/" + i0,schemaPath:"#/oneOf/0/properties/writableRoots/items/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data3) < 1){validate1501.errors = [{instancePath:instancePath+"/writableRoots/" + i0,schemaPath:"#/oneOf/0/properties/writableRoots/items/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern43.test(data3)){validate1501.errors = [{instancePath:instancePath+"/writableRoots/" + i0,schemaPath:"#/oneOf/0/properties/writableRoots/items/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*$"}}];return false;}}}}else {validate1501.errors = [{instancePath:instancePath+"/writableRoots/" + i0,schemaPath:"#/oneOf/0/properties/writableRoots/items/type",keyword:"type",params:{type: "string"}}];return false;}}var valid3: any = _errs11 === errors;if(!valid3){break;}}}}else {validate1501.errors = [{instancePath:instancePath+"/writableRoots",schemaPath:"#/oneOf/0/properties/writableRoots/type",keyword:"type",params:{type: "array"}}];return false;}}var valid2: any = _errs9 === errors;}else {var valid2: any = true;}}}}}}else {validate1501.errors = [{instancePath,schemaPath:"#/oneOf/0/type",keyword:"type",params:{type: "object"}}];return false;}}var valid1: any = _errs2 === errors;var props0: any = true;valid0 = valid1;}else if(tag0 === "ask"){const _errs13: any = errors;if(errors === _errs13){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if((((data.mode === undefined) && (missing1 = "mode")) || ((data.credentialPolicyRef === undefined) && (missing1 = "credentialPolicyRef"))) || ((data.writableRoots === undefined) && (missing1 = "writableRoots"))){validate1501.errors = [{instancePath,schemaPath:"#/oneOf/1/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs15: any = errors;for(const key1 in data){if(!(((key1 === "mode") || (key1 === "credentialPolicyRef")) || (key1 === "writableRoots"))){validate1501.errors = [{instancePath,schemaPath:"#/oneOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs15 === errors){if(data.mode !== undefined){let data4: any = data.mode;const _errs16: any = errors;if(typeof data4 !== "string"){validate1501.errors = [{instancePath:instancePath+"/mode",schemaPath:"#/oneOf/1/properties/mode/type",keyword:"type",params:{type: "string"}}];return false;}if("ask" !== data4){validate1501.errors = [{instancePath:instancePath+"/mode",schemaPath:"#/oneOf/1/properties/mode/const",keyword:"const",params:{allowedValue: "ask"}}];return false;}var valid5: any = _errs16 === errors;}else {var valid5: any = true;}if(valid5){if(data.credentialPolicyRef !== undefined){let data5: any = data.credentialPolicyRef;const _errs18: any = errors;if(errors === _errs18){if(typeof data5 === "string"){if(func1(data5) > 256){validate1501.errors = [{instancePath:instancePath+"/credentialPolicyRef",schemaPath:"#/oneOf/1/properties/credentialPolicyRef/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data5) < 1){validate1501.errors = [{instancePath:instancePath+"/credentialPolicyRef",schemaPath:"#/oneOf/1/properties/credentialPolicyRef/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data5)){validate1501.errors = [{instancePath:instancePath+"/credentialPolicyRef",schemaPath:"#/oneOf/1/properties/credentialPolicyRef/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate1501.errors = [{instancePath:instancePath+"/credentialPolicyRef",schemaPath:"#/oneOf/1/properties/credentialPolicyRef/type",keyword:"type",params:{type: "string"}}];return false;}}var valid5: any = _errs18 === errors;}else {var valid5: any = true;}if(valid5){if(data.writableRoots !== undefined){let data6: any = data.writableRoots;const _errs20: any = errors;if(errors === _errs20){if(Array.isArray(data6)){var valid6: any = true;const len1: any = data6.length;for(let i1=0; i1<len1; i1++){let data7: any = data6[i1];const _errs22: any = errors;if(errors === _errs22){if(typeof data7 === "string"){if(func1(data7) > 4096){validate1501.errors = [{instancePath:instancePath+"/writableRoots/" + i1,schemaPath:"#/oneOf/1/properties/writableRoots/items/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data7) < 1){validate1501.errors = [{instancePath:instancePath+"/writableRoots/" + i1,schemaPath:"#/oneOf/1/properties/writableRoots/items/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern43.test(data7)){validate1501.errors = [{instancePath:instancePath+"/writableRoots/" + i1,schemaPath:"#/oneOf/1/properties/writableRoots/items/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*$"}}];return false;}}}}else {validate1501.errors = [{instancePath:instancePath+"/writableRoots/" + i1,schemaPath:"#/oneOf/1/properties/writableRoots/items/type",keyword:"type",params:{type: "string"}}];return false;}}var valid6: any = _errs22 === errors;if(!valid6){break;}}}else {validate1501.errors = [{instancePath:instancePath+"/writableRoots",schemaPath:"#/oneOf/1/properties/writableRoots/type",keyword:"type",params:{type: "array"}}];return false;}}var valid5: any = _errs20 === errors;}else {var valid5: any = true;}}}}}}else {validate1501.errors = [{instancePath,schemaPath:"#/oneOf/1/type",keyword:"type",params:{type: "object"}}];return false;}}var valid4: any = _errs13 === errors;if(props0 !== true){props0 = true;}valid0 = valid4;}else if(tag0 === "reviewed"){const _errs24: any = errors;if(errors === _errs24){if(data && typeof data == "object" && !Array.isArray(data)){let missing2: any;if((((data.mode === undefined) && (missing2 = "mode")) || ((data.credentialPolicyRef === undefined) && (missing2 = "credentialPolicyRef"))) || ((data.writableRoots === undefined) && (missing2 = "writableRoots"))){validate1501.errors = [{instancePath,schemaPath:"#/oneOf/2/required",keyword:"required",params:{missingProperty: missing2}}];return false;}else {const _errs26: any = errors;for(const key2 in data){if(!(((key2 === "mode") || (key2 === "credentialPolicyRef")) || (key2 === "writableRoots"))){validate1501.errors = [{instancePath,schemaPath:"#/oneOf/2/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key2}}];return false;break;}}if(_errs26 === errors){if(data.mode !== undefined){let data8: any = data.mode;const _errs27: any = errors;if(typeof data8 !== "string"){validate1501.errors = [{instancePath:instancePath+"/mode",schemaPath:"#/oneOf/2/properties/mode/type",keyword:"type",params:{type: "string"}}];return false;}if("reviewed" !== data8){validate1501.errors = [{instancePath:instancePath+"/mode",schemaPath:"#/oneOf/2/properties/mode/const",keyword:"const",params:{allowedValue: "reviewed"}}];return false;}var valid8: any = _errs27 === errors;}else {var valid8: any = true;}if(valid8){if(data.credentialPolicyRef !== undefined){let data9: any = data.credentialPolicyRef;const _errs29: any = errors;if(errors === _errs29){if(typeof data9 === "string"){if(func1(data9) > 256){validate1501.errors = [{instancePath:instancePath+"/credentialPolicyRef",schemaPath:"#/oneOf/2/properties/credentialPolicyRef/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data9) < 1){validate1501.errors = [{instancePath:instancePath+"/credentialPolicyRef",schemaPath:"#/oneOf/2/properties/credentialPolicyRef/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data9)){validate1501.errors = [{instancePath:instancePath+"/credentialPolicyRef",schemaPath:"#/oneOf/2/properties/credentialPolicyRef/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate1501.errors = [{instancePath:instancePath+"/credentialPolicyRef",schemaPath:"#/oneOf/2/properties/credentialPolicyRef/type",keyword:"type",params:{type: "string"}}];return false;}}var valid8: any = _errs29 === errors;}else {var valid8: any = true;}if(valid8){if(data.writableRoots !== undefined){let data10: any = data.writableRoots;const _errs31: any = errors;if(errors === _errs31){if(Array.isArray(data10)){var valid9: any = true;const len2: any = data10.length;for(let i2=0; i2<len2; i2++){let data11: any = data10[i2];const _errs33: any = errors;if(errors === _errs33){if(typeof data11 === "string"){if(func1(data11) > 4096){validate1501.errors = [{instancePath:instancePath+"/writableRoots/" + i2,schemaPath:"#/oneOf/2/properties/writableRoots/items/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data11) < 1){validate1501.errors = [{instancePath:instancePath+"/writableRoots/" + i2,schemaPath:"#/oneOf/2/properties/writableRoots/items/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern43.test(data11)){validate1501.errors = [{instancePath:instancePath+"/writableRoots/" + i2,schemaPath:"#/oneOf/2/properties/writableRoots/items/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*$"}}];return false;}}}}else {validate1501.errors = [{instancePath:instancePath+"/writableRoots/" + i2,schemaPath:"#/oneOf/2/properties/writableRoots/items/type",keyword:"type",params:{type: "string"}}];return false;}}var valid9: any = _errs33 === errors;if(!valid9){break;}}}else {validate1501.errors = [{instancePath:instancePath+"/writableRoots",schemaPath:"#/oneOf/2/properties/writableRoots/type",keyword:"type",params:{type: "array"}}];return false;}}var valid8: any = _errs31 === errors;}else {var valid8: any = true;}}}}}}else {validate1501.errors = [{instancePath,schemaPath:"#/oneOf/2/type",keyword:"type",params:{type: "object"}}];return false;}}var valid7: any = _errs24 === errors;if(props0 !== true){props0 = true;}valid0 = valid7;}else if(tag0 === "sandboxed"){const _errs35: any = errors;if(errors === _errs35){if(data && typeof data == "object" && !Array.isArray(data)){let missing3: any;if((((data.mode === undefined) && (missing3 = "mode")) || ((data.credentialPolicyRef === undefined) && (missing3 = "credentialPolicyRef"))) || ((data.writableRoots === undefined) && (missing3 = "writableRoots"))){validate1501.errors = [{instancePath,schemaPath:"#/oneOf/3/required",keyword:"required",params:{missingProperty: missing3}}];return false;}else {const _errs37: any = errors;for(const key3 in data){if(!(((key3 === "mode") || (key3 === "credentialPolicyRef")) || (key3 === "writableRoots"))){validate1501.errors = [{instancePath,schemaPath:"#/oneOf/3/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key3}}];return false;break;}}if(_errs37 === errors){if(data.mode !== undefined){let data12: any = data.mode;const _errs38: any = errors;if(typeof data12 !== "string"){validate1501.errors = [{instancePath:instancePath+"/mode",schemaPath:"#/oneOf/3/properties/mode/type",keyword:"type",params:{type: "string"}}];return false;}if("sandboxed" !== data12){validate1501.errors = [{instancePath:instancePath+"/mode",schemaPath:"#/oneOf/3/properties/mode/const",keyword:"const",params:{allowedValue: "sandboxed"}}];return false;}var valid11: any = _errs38 === errors;}else {var valid11: any = true;}if(valid11){if(data.credentialPolicyRef !== undefined){let data13: any = data.credentialPolicyRef;const _errs40: any = errors;if(errors === _errs40){if(typeof data13 === "string"){if(func1(data13) > 256){validate1501.errors = [{instancePath:instancePath+"/credentialPolicyRef",schemaPath:"#/oneOf/3/properties/credentialPolicyRef/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data13) < 1){validate1501.errors = [{instancePath:instancePath+"/credentialPolicyRef",schemaPath:"#/oneOf/3/properties/credentialPolicyRef/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data13)){validate1501.errors = [{instancePath:instancePath+"/credentialPolicyRef",schemaPath:"#/oneOf/3/properties/credentialPolicyRef/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate1501.errors = [{instancePath:instancePath+"/credentialPolicyRef",schemaPath:"#/oneOf/3/properties/credentialPolicyRef/type",keyword:"type",params:{type: "string"}}];return false;}}var valid11: any = _errs40 === errors;}else {var valid11: any = true;}if(valid11){if(data.writableRoots !== undefined){let data14: any = data.writableRoots;const _errs42: any = errors;if(errors === _errs42){if(Array.isArray(data14)){var valid12: any = true;const len3: any = data14.length;for(let i3=0; i3<len3; i3++){let data15: any = data14[i3];const _errs44: any = errors;if(errors === _errs44){if(typeof data15 === "string"){if(func1(data15) > 4096){validate1501.errors = [{instancePath:instancePath+"/writableRoots/" + i3,schemaPath:"#/oneOf/3/properties/writableRoots/items/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data15) < 1){validate1501.errors = [{instancePath:instancePath+"/writableRoots/" + i3,schemaPath:"#/oneOf/3/properties/writableRoots/items/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern43.test(data15)){validate1501.errors = [{instancePath:instancePath+"/writableRoots/" + i3,schemaPath:"#/oneOf/3/properties/writableRoots/items/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*$"}}];return false;}}}}else {validate1501.errors = [{instancePath:instancePath+"/writableRoots/" + i3,schemaPath:"#/oneOf/3/properties/writableRoots/items/type",keyword:"type",params:{type: "string"}}];return false;}}var valid12: any = _errs44 === errors;if(!valid12){break;}}}else {validate1501.errors = [{instancePath:instancePath+"/writableRoots",schemaPath:"#/oneOf/3/properties/writableRoots/type",keyword:"type",params:{type: "array"}}];return false;}}var valid11: any = _errs42 === errors;}else {var valid11: any = true;}}}}}}else {validate1501.errors = [{instancePath,schemaPath:"#/oneOf/3/type",keyword:"type",params:{type: "object"}}];return false;}}var valid10: any = _errs35 === errors;if(props0 !== true){props0 = true;}valid0 = valid10;}else if(tag0 === "yolo"){const _errs46: any = errors;if(errors === _errs46){if(data && typeof data == "object" && !Array.isArray(data)){let missing4: any;if((((data.mode === undefined) && (missing4 = "mode")) || ((data.credentialPolicyRef === undefined) && (missing4 = "credentialPolicyRef"))) || ((data.writableRoots === undefined) && (missing4 = "writableRoots"))){validate1501.errors = [{instancePath,schemaPath:"#/oneOf/4/required",keyword:"required",params:{missingProperty: missing4}}];return false;}else {const _errs48: any = errors;for(const key4 in data){if(!(((key4 === "mode") || (key4 === "credentialPolicyRef")) || (key4 === "writableRoots"))){validate1501.errors = [{instancePath,schemaPath:"#/oneOf/4/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key4}}];return false;break;}}if(_errs48 === errors){if(data.mode !== undefined){let data16: any = data.mode;const _errs49: any = errors;if(typeof data16 !== "string"){validate1501.errors = [{instancePath:instancePath+"/mode",schemaPath:"#/oneOf/4/properties/mode/type",keyword:"type",params:{type: "string"}}];return false;}if("yolo" !== data16){validate1501.errors = [{instancePath:instancePath+"/mode",schemaPath:"#/oneOf/4/properties/mode/const",keyword:"const",params:{allowedValue: "yolo"}}];return false;}var valid14: any = _errs49 === errors;}else {var valid14: any = true;}if(valid14){if(data.credentialPolicyRef !== undefined){let data17: any = data.credentialPolicyRef;const _errs51: any = errors;if(errors === _errs51){if(typeof data17 === "string"){if(func1(data17) > 256){validate1501.errors = [{instancePath:instancePath+"/credentialPolicyRef",schemaPath:"#/oneOf/4/properties/credentialPolicyRef/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data17) < 1){validate1501.errors = [{instancePath:instancePath+"/credentialPolicyRef",schemaPath:"#/oneOf/4/properties/credentialPolicyRef/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data17)){validate1501.errors = [{instancePath:instancePath+"/credentialPolicyRef",schemaPath:"#/oneOf/4/properties/credentialPolicyRef/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate1501.errors = [{instancePath:instancePath+"/credentialPolicyRef",schemaPath:"#/oneOf/4/properties/credentialPolicyRef/type",keyword:"type",params:{type: "string"}}];return false;}}var valid14: any = _errs51 === errors;}else {var valid14: any = true;}if(valid14){if(data.writableRoots !== undefined){let data18: any = data.writableRoots;const _errs53: any = errors;if(errors === _errs53){if(Array.isArray(data18)){if(data18.length > 0){validate1501.errors = [{instancePath:instancePath+"/writableRoots",schemaPath:"#/oneOf/4/properties/writableRoots/maxItems",keyword:"maxItems",params:{limit: 0}}];return false;}else {var valid15: any = true;const len4: any = data18.length;for(let i4=0; i4<len4; i4++){let data19: any = data18[i4];const _errs55: any = errors;if(errors === _errs55){if(typeof data19 === "string"){if(func1(data19) > 4096){validate1501.errors = [{instancePath:instancePath+"/writableRoots/" + i4,schemaPath:"#/oneOf/4/properties/writableRoots/items/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data19) < 1){validate1501.errors = [{instancePath:instancePath+"/writableRoots/" + i4,schemaPath:"#/oneOf/4/properties/writableRoots/items/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern43.test(data19)){validate1501.errors = [{instancePath:instancePath+"/writableRoots/" + i4,schemaPath:"#/oneOf/4/properties/writableRoots/items/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*$"}}];return false;}}}}else {validate1501.errors = [{instancePath:instancePath+"/writableRoots/" + i4,schemaPath:"#/oneOf/4/properties/writableRoots/items/type",keyword:"type",params:{type: "string"}}];return false;}}var valid15: any = _errs55 === errors;if(!valid15){break;}}}}else {validate1501.errors = [{instancePath:instancePath+"/writableRoots",schemaPath:"#/oneOf/4/properties/writableRoots/type",keyword:"type",params:{type: "array"}}];return false;}}var valid14: any = _errs53 === errors;}else {var valid14: any = true;}}}}}}else {validate1501.errors = [{instancePath,schemaPath:"#/oneOf/4/type",keyword:"type",params:{type: "object"}}];return false;}}var valid13: any = _errs46 === errors;if(props0 !== true){props0 = true;}valid0 = valid13;}else {validate1501.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "mapping", tag: "mode", tagValue: tag0}}];return false;}}else {validate1501.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "tag", tag: "mode", tagValue: tag0}}];return false;}if(valid0){if(props0 !== true){for(const key5 in data){if(!props0 || !props0[key5]){validate1501.errors = [{instancePath,schemaPath:"#/unevaluatedProperties",keyword:"unevaluatedProperties",params:{unevaluatedProperty: key5}}];return false;break;}}}}}else {validate1501.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1501.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1501.errors = null as any[] | null;
// prettier-ignore
validate1501.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link ExecutionPosture}. */
export const validateExecutionPosture: SchemaCheck<ExecutionPosture> = validate1501;
