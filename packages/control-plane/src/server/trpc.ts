// One `t` builder is shared by every router the host mounts: routers built from separate
// `initTRPC` calls have incompatible procedure types and cannot compose into one router.
// The explicit `TRPCRootObject<...>` annotation on `t` is required by `isolatedDeclarations`.

import {
  initTRPC,
  TRPCError,
  type TRPC_ERROR_CODE_KEY,
  type TRPCDefaultErrorData,
  type TRPCErrorFormatter,
  type TRPCErrorShape,
  type TRPCRootObject,
} from "@trpc/server";

import type { AdmissionCheck } from "../rate-limit/enforcement-pipeline.js";

/** The per-request context every control-plane procedure receives. */
export interface ControlPlaneContext {
  /** Stable per-request identifier; stamped at host fetch entry. */
  readonly requestId: string;
  /**
   * The caller's address as the deployment's edge reports it, before canonical form: the
   * `CF-Connecting-IP` header on Workers, the trust-proxy address on the self-hosted relay.
   */
  readonly sourceAddress: string | undefined;
  /** The headers the fetch adapter merges into this request's response, an error's included. */
  readonly responseHeaders: Headers;
  /** Counts this request against its endpoint group's limit before a counted procedure runs. */
  readonly checkAdmission: AdmissionCheck;
}

// What a typed refusal puts in the error's `data`: a code a caller reads without parsing the
// message, a message unless the refusal's own contract leaves it out, and that contract's members.
interface RefusalBody {
  readonly code: string;
  readonly message?: string;
}

/**
 * A refusal a caller tells apart by its code. tRPC answers it with the HTTP status of `trpcCode`,
 * and the shared error formatter makes `body` the error's whole `data`.
 */
export class ControlPlaneRefusal extends TRPCError {
  readonly body: RefusalBody;

  constructor(options: {
    readonly trpcCode: TRPC_ERROR_CODE_KEY;
    readonly message: string;
    readonly body: RefusalBody;
  }) {
    super({ code: options.trpcCode, message: options.message });
    this.body = options.body;
  }
}

type ControlPlaneErrorShape = TRPCErrorShape<TRPCDefaultErrorData | RefusalBody>;

/** The shared tRPC builder every control-plane router is built on. */
export const t: TRPCRootObject<
  ControlPlaneContext,
  object,
  { errorFormatter: TRPCErrorFormatter<ControlPlaneContext, ControlPlaneErrorShape> }
> = initTRPC.context<ControlPlaneContext>().create({
  // tRPC otherwise reads `NODE_ENV`, which workerd lacks, and would send every caller the stack.
  isDev: false,
  errorFormatter: ({ error, shape }): ControlPlaneErrorShape =>
    error instanceof ControlPlaneRefusal ? { ...shape, data: error.body } : shape,
});
