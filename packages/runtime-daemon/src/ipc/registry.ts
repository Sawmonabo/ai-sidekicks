// MethodRegistryImpl: the daemon-side implementation of the `MethodRegistry` interface from
// `@ai-sidekicks/contracts`, wired into `LocalIpcGateway` dispatch.
//
// * A duplicate method name is rejected synchronously at `register()`, so the failure shows up
//   during daemon bootstrap before any listener binds.
// * Schema validation runs before the handler: `dispatch()` checks `has`, then
//   `paramsSchema.safeParse`, then calls the handler only on success, then checks the result with
//   `resultSchema.safeParse`. The handler never sees a malformed payload.
// * Method names must match the dotted-camelCase `METHOD_NAME_FORMAT` from
//   `@ai-sidekicks/contracts` or the LSP-style `$/` shape below; `register()` checks this.
// * Mapping errors to JSON-RPC codes belongs to `mapJsonRpcError` and response framing to the
//   gateway. The registry throws `RegistryDispatchError` with a stable `registryCode` and
//   returns plain values.
// * The registry does not enforce version gating; it only exposes `isMutating(method)` for the
//   protocol negotiator to consult.
// * `DelegatingRegistry` wraps a registry with a step of its own before or around `dispatch`; the
//   protocol gate, the recovery gate and the in-flight record are each built on it.

import type {
  Handler,
  HandlerContext,
  MethodRegistry,
  RegisterOptions,
  ZodType,
} from "@ai-sidekicks/contracts/jsonrpc/registry";
import { METHOD_NAME_FORMAT } from "@ai-sidekicks/contracts/jsonrpc/registry";
import type { DeviceId } from "@ai-sidekicks/contracts/trust-statement";

// --------------------------------------------------------------------------
// Method-name format regexes
// --------------------------------------------------------------------------

// `METHOD_NAME_FORMAT` (imported above) is the dotted-camelCase shape; only the LSP-style
// sibling is declared here.

/**
 * LSP-style `$/`-prefixed system method shape, such as `$/subscription/notify` and
 * `$/cancelRequest`: a literal `$/`, then a lowercase-leading camelCase identifier, then zero or
 * more `/`-separated identifiers. Names without the slash, with an uppercase head, or with an
 * empty segment (`$cancel`, `$/Subscription/notify`, `$//notify`) do not match.
 */
const METHOD_NAME_LSP_REGEX = /^\$\/[a-z][a-zA-Z0-9]*(?:\/[a-z][a-zA-Z0-9]*)*$/;

/** Whether `method` matches the dotted-camelCase format or the LSP `$/` system-method format. */
function isCanonicalMethodName(method: string): boolean {
  return METHOD_NAME_FORMAT.test(method) || METHOD_NAME_LSP_REGEX.test(method);
}

// --------------------------------------------------------------------------
// Registry error classes (daemon-internal)
// --------------------------------------------------------------------------

/**
 * Codes for registration failures, on `RegistryRegistrationError.registryCode`.
 *
 * * `"duplicate_method"`: a second `register()` for an already registered name.
 * * `"invalid_method_name"`: the name matches neither the dotted-camelCase format nor the
 *   LSP-style `$/` format.
 */
export type RegistryRegistrationCode = "duplicate_method" | "invalid_method_name";

/**
 * Thrown synchronously from `register()`. It marks a wiring bug at the registration site, so the
 * daemon should let it propagate and refuse to start. It is distinct from `RegistryDispatchError`,
 * which is a per-request failure. `message` names the method and is safe to log.
 */
export class RegistryRegistrationError extends Error {
  readonly registryCode: RegistryRegistrationCode;

  constructor(registryCode: RegistryRegistrationCode, message: string) {
    super(message);
    this.name = "RegistryRegistrationError";
    this.registryCode = registryCode;
  }
}

/**
 * Codes for dispatch failures, on `RegistryDispatchError.registryCode`. The error mapper turns
 * them into JSON-RPC numeric codes.
 *
 * * `"method_not_found"`: the method is not registered (`-32601`).
 * * `"invalid_params"`: `paramsSchema.safeParse` failed; the handler was not invoked (`-32602`).
 * * `"invalid_result"`: the handler's return value failed `resultSchema.safeParse`. The daemon is
 *   at fault, not the client, so it maps to `-32603` rather than `-32602`.
 */
export type RegistryDispatchCode = "method_not_found" | "invalid_params" | "invalid_result";

/**
 * Thrown from `dispatch()`. For `"invalid_params"` and `"invalid_result"`, `issues` holds the raw
 * zod issue array, typed `unknown` so the registry does not depend on zod's issue shape.
 */
export class RegistryDispatchError extends Error {
  readonly registryCode: RegistryDispatchCode;
  readonly issues: ReadonlyArray<unknown> | undefined;

  constructor(
    registryCode: RegistryDispatchCode,
    message: string,
    issues?: ReadonlyArray<unknown>,
  ) {
    super(message);
    this.name = "RegistryDispatchError";
    this.registryCode = registryCode;
    this.issues = issues;
  }
}

// --------------------------------------------------------------------------
// Internal: per-method entry
// --------------------------------------------------------------------------

// One registered method. `P` and `R` are erased to `unknown` so a single map holds every method;
// `register<P, R>` keeps the schema and handler types matched at the call site.
interface RegistryEntry {
  readonly paramsSchema: ZodType<unknown>;
  readonly resultSchema: ZodType<unknown>;
  readonly handler: Handler<unknown, unknown>;
  readonly mutating: boolean;
}

// --------------------------------------------------------------------------
// MethodRegistryImpl
// --------------------------------------------------------------------------

/**
 * The runtime `MethodRegistry`. It is a class rather than a module singleton because a registry
 * is per-process and per-test state, and a singleton would need a reset hook for tests.
 */
export class MethodRegistryImpl implements MethodRegistry {
  readonly #methods: Map<string, RegistryEntry>;

  constructor() {
    this.#methods = new Map();
  }

  /**
   * Registers a typed handler under `method`. Throws `RegistryRegistrationError` for a malformed
   * name (checked first) or a duplicate. `opts.mutating` defaults to `false`.
   */
  register<P, R>(
    method: string,
    paramsSchema: ZodType<P>,
    resultSchema: ZodType<R>,
    handler: Handler<P, R>,
    opts?: RegisterOptions,
  ): void {
    if (!isCanonicalMethodName(method)) {
      throw new RegistryRegistrationError(
        "invalid_method_name",
        `MethodRegistry.register: method name ${JSON.stringify(method)} does not match the ` +
          `canonical dotted-camelCase format 'namespace.method' or the LSP-style ` +
          `'$/segment[/segment]*' system-method shape`,
      );
    }

    if (this.#methods.has(method)) {
      throw new RegistryRegistrationError(
        "duplicate_method",
        `MethodRegistry.register: method ${JSON.stringify(method)} is already registered ` +
          `(duplicate registrations are rejected at register-time, not dispatch-time)`,
      );
    }

    const entry: RegistryEntry = {
      // Erasing `P` and `R` is sound: the signature ties each schema to the handler's types, so
      // anything `safeParse` accepts is a value the handler accepts.
      paramsSchema: paramsSchema as ZodType<unknown>,
      resultSchema: resultSchema as ZodType<unknown>,
      handler: handler as Handler<unknown, unknown>,
      // Compared with `true` so the field is always a boolean under exactOptionalPropertyTypes.
      mutating: opts?.mutating === true,
    };
    this.#methods.set(method, entry);
  }

  /**
   * Runs a request through its handler with validation on both sides. Throws
   * `RegistryDispatchError`: `method_not_found` for an unknown method, `invalid_params` before
   * the handler runs, and `invalid_result` when the handler's return value fails its schema.
   */
  async dispatch(method: string, params: unknown, ctx: HandlerContext): Promise<unknown> {
    const entry = this.#methods.get(method);
    if (entry === undefined) {
      throw new RegistryDispatchError(
        "method_not_found",
        `MethodRegistry.dispatch: method ${JSON.stringify(method)} is not registered`,
      );
    }

    const parsedParams = entry.paramsSchema.safeParse(params);
    if (!parsedParams.success) {
      throw new RegistryDispatchError(
        "invalid_params",
        `MethodRegistry.dispatch: params validation failed for method ${JSON.stringify(method)}`,
        parsedParams.error.issues,
      );
    }

    const result = await entry.handler(parsedParams.data, ctx);

    const parsedResult = entry.resultSchema.safeParse(result);
    if (!parsedResult.success) {
      throw new RegistryDispatchError(
        "invalid_result",
        `MethodRegistry.dispatch: result validation failed for method ` +
          `${JSON.stringify(method)} (handler returned a value that does not match the ` +
          `registered resultSchema; programmer error)`,
        parsedResult.error.issues,
      );
    }
    return parsedResult.data;
  }

  /** Whether `method` is registered. */
  has(method: string): boolean {
    return this.#methods.has(method);
  }

  /**
   * Whether `method` was registered with `mutating: true`, or `undefined` when it is not
   * registered. The version gate needs all three answers: unknown (let dispatch report
   * `method_not_found`), read-only (allow), mutating (refuse on a version mismatch).
   */
  isMutating(method: string): boolean | undefined {
    const entry = this.#methods.get(method);
    if (entry === undefined) {
      return undefined;
    }
    return entry.mutating;
  }
}

// --------------------------------------------------------------------------
// DelegatingRegistry
// --------------------------------------------------------------------------

/**
 * A registry wrapped around `inner`: `register`, `has` and `isMutating` go to `inner` unchanged,
 * and `dispatch` goes through the `dispatch` it is built with, which calls `inner` itself.
 */
export class DelegatingRegistry implements MethodRegistry {
  readonly #inner: MethodRegistry;
  readonly #dispatch: (method: string, params: unknown, ctx: HandlerContext) => Promise<unknown>;

  constructor(
    inner: MethodRegistry,
    dispatch: (method: string, params: unknown, ctx: HandlerContext) => Promise<unknown>,
  ) {
    this.#inner = inner;
    this.#dispatch = dispatch;
  }

  register<P, R>(
    method: string,
    paramsSchema: ZodType<P>,
    resultSchema: ZodType<R>,
    handler: Handler<P, R>,
    opts?: RegisterOptions,
  ): void {
    // `opts` is forwarded only when present (exactOptionalPropertyTypes).
    if (opts === undefined) {
      this.#inner.register(method, paramsSchema, resultSchema, handler);
    } else {
      this.#inner.register(method, paramsSchema, resultSchema, handler, opts);
    }
  }

  dispatch(method: string, params: unknown, ctx: HandlerContext): Promise<unknown> {
    return this.#dispatch(method, params, ctx);
  }

  has(method: string): boolean {
    return this.#inner.has(method);
  }

  isMutating(method: string): boolean | undefined {
    return this.#inner.isMutating(method);
  }
}

// --------------------------------------------------------------------------
// Calling device
// --------------------------------------------------------------------------

/**
 * The device the gateway stamped on a call, which a handler records as the call's author. Throws a
 * plain `Error` naming `method` when no device is stamped: that is a daemon wiring fault, never a
 * client's, since every call on the local socket carries the service's own device.
 */
export function callingDeviceOf(ctx: HandlerContext, method: string): DeviceId {
  if (ctx.deviceId === undefined) {
    throw new Error(`${method} needs the calling device`);
  }
  return ctx.deviceId;
}
