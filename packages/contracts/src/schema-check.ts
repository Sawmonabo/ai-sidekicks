// What a generated schema check needs at run time: the type every check has, the context that
// carries a message's byte attachments, the two `format` rules no JSON Schema keyword states, and
// the two Ajv helpers the checks call. The checks are generated from the Rust contracts.
import type { ErrorObject } from "ajv";
import ajvEqualModule from "ajv/dist/runtime/equal.js";
import ajvUcs2lengthModule from "ajv/dist/runtime/ucs2length.js";

import { webAddressFault } from "./web-address.js";

/**
 * The byte attachments a message carries beside its JSON; a member written `{"$bytes": n}` is
 * attachment `n`. A check whose type holds bytes reads them from here, so it is called as
 * `check.call({ attachments }, value)`; called without them, it refuses every such value.
 */
export interface SchemaCheckContext {
  readonly attachments: readonly Uint8Array[];
}

/**
 * A generated check: answers whether `value` is a `T` and, when it is not, leaves every fault in
 * `errors` (Ajv's error objects, without messages). It reads and never changes the value.
 *
 * @consumedBy the generated contract checks and the clients that call them
 */
export interface SchemaCheck<T> {
  (this: SchemaCheckContext | void, value: unknown): value is T;
  errors?: ErrorObject[] | null;
}

/** Whether `origin` is exactly a web address's origin: `scheme://host[:port]` and nothing more. */
function isSiteOrigin(origin: string): boolean {
  const address = URL.parse(origin);
  return address !== null && webAddressFault(address) === null && address.origin === origin;
}

/** Whether `address`, trimmed, parses as an `https:` address. */
function isHttpsAddress(address: string): boolean {
  return URL.parse(address.trim())?.protocol === "https:";
}

/**
 * The `format` rules a contract schema names, each a function of the string it checks; a schema
 * naming a format missing here fails to typecheck its generated check.
 *
 * @consumedBy the generated contract checks
 */
export const SCHEMA_FORMATS: {
  readonly "site-origin": (origin: string) => boolean;
  readonly "https-url": (address: string) => boolean;
} = Object.freeze({ "site-origin": isSiteOrigin, "https-url": isHttpsAddress });

/**
 * A CommonJS module's `exports.default`: Node, esbuild and Rolldown import such a module from an
 * ES module package as its `module.exports`, while Vitest hands over `exports.default` itself.
 */
function commonJsDefault(imported: unknown): unknown {
  return (imported as { default?: unknown }).default ?? imported;
}

/**
 * Ajv's length of `text` in code points, as `minLength` and `maxLength` count it.
 *
 * @consumedBy the generated contract checks
 */
export const ucs2length: (text: string) => number = commonJsDefault(ajvUcs2lengthModule) as (
  text: string,
) => number;

/**
 * Ajv's structural equality, which `const`, `enum` and `uniqueItems` use on objects.
 *
 * @consumedBy the generated contract checks
 */
export const deepEqual: (left: unknown, right: unknown) => boolean = commonJsDefault(
  ajvEqualModule,
) as (left: unknown, right: unknown) => boolean;
