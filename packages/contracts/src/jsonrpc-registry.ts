// The typed surface of the daemon's method registry, so a package can register handlers without
// depending on the runtime-daemon package. The implementation is
// `packages/runtime-daemon/src/ipc/registry.ts`.

// Type-only: keeps zod out of this file's runtime surface.
import type { ZodType } from "zod";

// Re-exported so the daemon's registry can name `ZodType` without listing zod as a dependency.
export type { ZodType };

/**
 * The format of a method name: dot-separated segments, each starting lowercase and possibly
 * camelCase, with at least one dot (`session.create`, `providerAccount.list`). The daemon registry
 * checks names against it at register time, and also accepts LSP-style `$/…` names. It has no `g`
 * flag, so `.test()` is stateless.
 */
export const METHOD_NAME_FORMAT: RegExp = /^[a-z][a-zA-Z0-9]*(?:\.[a-z][a-zA-Z0-9]*)+$/;

/**
 * Per-dispatch context passed to every handler. `transportId` is the gateway's id for the
 * connection the call arrived on; it is absent when a caller dispatches without a transport, as
 * tests do.
 */
export interface HandlerContext {
  readonly transportId?: number;
}

/**
 * A method handler. It receives params that already passed the registered params schema and must
 * resolve to a value that passes the registered result schema. Always async.
 */
export type Handler<P, R> = (params: P, ctx: HandlerContext) => Promise<R>;

/**
 * Options for `register`. `mutating` marks a method that changes domain state; the daemon refuses
 * it while the protocol handshake is incompatible and lets read-only methods through. It defaults
 * to false.
 */
export interface RegisterOptions {
  readonly mutating?: boolean;
}

/**
 * The registry of method handlers, keyed by method name. Names are unique. A dispatch validates
 * params, runs the handler, then validates the result.
 */
export interface MethodRegistry {
  /**
   * Registers `handler` for `method`, validating params with `paramsSchema` before the handler
   * runs and its result with `resultSchema` after.
   *
   * @throws RegistryRegistrationError synchronously when `method` is already registered or is not a
   * valid method name.
   */
  register<P, R>(
    method: string,
    paramsSchema: ZodType<P>,
    resultSchema: ZodType<R>,
    handler: Handler<P, R>,
    opts?: RegisterOptions,
  ): void;

  /**
   * Runs the handler registered for `method` and resolves to its validated result. Throws a
   * `RegistryDispatchError` coded `method_not_found`, `invalid_params` (the handler never runs) or
   * `invalid_result`. The result is `unknown` because the registry is generic over every method.
   */
  dispatch(method: string, params: unknown, ctx: HandlerContext): Promise<unknown>;

  /** Whether `method` is registered. */
  has(method: string): boolean;

  /**
   * Whether `method` was registered as mutating, or `undefined` when it is not registered, so a
   * caller can tell an unknown method from a read-only one.
   */
  isMutating(method: string): boolean | undefined;
}
