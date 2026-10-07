// A sign-in route counted by the rate-limit middleware, served through tRPC's real fetch adapter,
// and readers for what a caller gets back. Shared by the Node tests and the workerd tests.

import {
  RateLimitResponseSchema,
  type RateLimitResponse,
} from "@ai-sidekicks/contracts/rate-limiter";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { z } from "zod";

import { t, type ControlPlaneContext } from "../../server/trpc.js";
import { rateLimitProcedure } from "../rate-limit.js";

const signInRouter = t.router({
  signIn: t.procedure
    .use(rateLimitProcedure({ endpoint: "auth.endpoint" }))
    .query(() => "signed in"),
});

const ErrorBodySchema = z.object({ error: z.object({ data: z.unknown() }) });

/** What a caller reads back from one sign-in request. */
export interface SignInAnswer {
  readonly status: number;
  readonly retryAfterHeader: string | null;
  readonly body: unknown;
}

/** A sign-in request; `headers` carries what the edge adds, such as the caller's address. */
export function createSignInRequest(headers: Record<string, string> = {}): Request {
  return new Request("https://relay.test/trpc/signIn", { headers });
}

/** Serves one sign-in request, building its context from the response headers tRPC sends. */
export async function sendSignIn(
  request: Request,
  createContext: (responseHeaders: Headers) => ControlPlaneContext,
): Promise<SignInAnswer> {
  const response = await fetchRequestHandler({
    endpoint: "/trpc",
    req: request,
    router: signInRouter,
    createContext: ({ resHeaders }) => createContext(resHeaders),
  });
  return {
    status: response.status,
    retryAfterHeader: response.headers.get("Retry-After"),
    body: await response.json(),
  };
}

/** The error's `data` of a refused request; throws when the body is not a tRPC error. */
export function readErrorData(body: unknown): unknown {
  return ErrorBodySchema.parse(body).error.data;
}

/** The rate-limit body of a 429; throws when the error's `data` is not exactly that body. */
export function readRateLimitRefusal(body: unknown): RateLimitResponse {
  return RateLimitResponseSchema.parse(readErrorData(body));
}
