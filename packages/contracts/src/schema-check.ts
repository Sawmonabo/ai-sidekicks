// What a generated schema check needs at run time: the type every check has, the context that
// carries a message's byte attachments, the `format` rules no JSON Schema keyword states, the
// byte measure of a value's byte cap, and the two Ajv helpers the checks call. The checks are
// generated from the Rust contracts.
import type { ErrorObject } from "ajv";
import ajvEqualModule from "ajv/dist/runtime/equal.js";
import ajvUcs2lengthModule from "ajv/dist/runtime/ucs2length.js";

import { jsonUtf8ByteLength } from "./jsonrpc/byte-length.js";
import { isSiteOrigin, webAddressFault } from "./web-address/rule.js";

/**
 * The byte attachments a message carries beside its JSON; a member written `{"$bytes": n}` is
 * attachment `n`. A check whose type holds bytes reads them from here, so it is called as
 * `check.call({ attachments }, value)`; called without them, it refuses every such value.
 */
export interface SchemaCheckContext {
  readonly attachments: readonly Uint8Array[];
}

/**
 * A generated check: answers whether `value` is a `T` and, when it is not, leaves the first fault
 * in `errors` (Ajv's error object, without a message). It reads and never changes the value.
 */
export interface SchemaCheck<T> {
  (this: SchemaCheckContext | void, value: unknown): value is T;
  errors?: ErrorObject[] | null;
}

/** Whether `address`, trimmed, parses as an `https:` address. */
function isHttpsAddress(address: string): boolean {
  return URL.parse(address.trim())?.protocol === "https:";
}

/** Whether `address`, trimmed, parses as a web address the app opens: `http:` or `https:`. */
function isWebAddress(address: string): boolean {
  const parsed = URL.parse(address.trim());
  return parsed !== null && webAddressFault(parsed) === null;
}

/** A `format` rule on numbers, in the object form Ajv reads a non-string format from. */
interface NumberFormat {
  readonly type: "number";
  readonly validate: (value: number) => boolean;
}

/** A Rust `u32`: an integer from 0 to 4,294,967,295. */
const UINT32_FORMAT: NumberFormat = Object.freeze({
  type: "number",
  validate: (value: number) => Number.isInteger(value) && value >= 0 && value <= 0xffff_ffff,
});

/**
 * A Rust `i64`: an integer from -2^63 to 2^63 - 1. A JavaScript number reads the top bound as
 * 2^63, so that is the largest value taken.
 */
const INT64_FORMAT: NumberFormat = Object.freeze({
  type: "number",
  validate: (value: number) => Number.isInteger(value) && value >= -(2 ** 63) && value <= 2 ** 63,
});

/**
 * The `format` rules a contract schema names: a function of the string it checks, or a number
 * rule in Ajv's object form. A schema naming a format missing here fails to typecheck its
 * generated check.
 */
export const SCHEMA_FORMATS: {
  readonly "site-origin": (origin: string) => boolean;
  readonly "https-url": (address: string) => boolean;
  readonly "web-url": (address: string) => boolean;
  readonly uint32: NumberFormat;
  readonly int64: NumberFormat;
} = Object.freeze({
  "site-origin": isSiteOrigin,
  "https-url": isHttpsAddress,
  "web-url": isWebAddress,
  uint32: UINT32_FORMAT,
  int64: INT64_FORMAT,
});

/**
 * The bytes `value` takes in its message, as a byte cap measures them: its JSON's UTF-8 length
 * plus every attachment its `{"$bytes": n}` members name, since those ride in the same frame. A
 * member naming no attachment of `attachments` measures infinite, so every cap refuses it.
 */
export function wireByteLength(
  value: unknown,
  attachments: readonly Uint8Array[] | undefined,
): number {
  let byteLength = jsonUtf8ByteLength(value);
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const node = pending.pop();
    if (node === null || typeof node !== "object") {
      continue;
    }
    const index = (node as { $bytes?: unknown }).$bytes;
    if (Number.isInteger(index) && Object.keys(node).length === 1) {
      const attachment = attachments?.[index as number];
      if (!(attachment instanceof Uint8Array)) {
        return Number.POSITIVE_INFINITY;
      }
      byteLength += attachment.byteLength;
    } else {
      for (const member of Object.values(node)) {
        pending.push(member);
      }
    }
  }
  return byteLength;
}

/**
 * A CommonJS module's `exports.default`: Node, esbuild and Rolldown import such a module from an
 * ES module package as its `module.exports`, while Vitest hands over `exports.default` itself.
 */
function commonJsDefault(imported: unknown): unknown {
  return (imported as { default?: unknown }).default ?? imported;
}

/** Ajv's length of `text` in code points, as `minLength` and `maxLength` count it. */
export const ucs2length: (text: string) => number = commonJsDefault(ajvUcs2lengthModule) as (
  text: string,
) => number;

/** Ajv's structural equality, which `const`, `enum` and `uniqueItems` use on objects. */
export const deepEqual: (left: unknown, right: unknown) => boolean = commonJsDefault(
  ajvEqualModule,
) as (left: unknown, right: unknown) => boolean;
