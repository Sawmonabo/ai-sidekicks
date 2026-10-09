// The session's agent tree: how the daemon's index names each agent in a session, an agent with an
// id or a provider's own helper by its run and handle. Spend and tree positions key on it.
import { z } from "zod";

import { AgentIdSchema, type AgentId } from "./definition.js";
import { DRIVER_WIRE_HANDLE_MAX_LEN } from "../provider/driver/methods.js";
import { RunIdSchema, type RunId } from "../run/id.js";

/**
 * The daemon-minted handle of a provider's own helper inside its parent's run.
 * Opaque, and resolved only by the daemon, whose parent-to-child index minted it.
 */
export type ChildHandle = string & { readonly __brand: "ChildHandle" };
/** Parses a {@link ChildHandle}: a non-empty string up to the wire's handle bound. */
export const ChildHandleSchema: z.ZodType<ChildHandle, ChildHandle> = z
  .string()
  .min(1)
  .max(DRIVER_WIRE_HANDLE_MAX_LEN)
  .brand<"ChildHandle">() as unknown as z.ZodType<ChildHandle, ChildHandle>;

/**
 * One agent in the session's tree as the daemon's index names it: an agent with an
 * id (the lead, or an agent a bridge `run` started), or a provider's own helper by
 * the run it runs in and its handle. Per-agent spend and a tree position both key
 * on it.
 */
export type AgentTreeMember =
  | { kind: "agent"; agentId: AgentId }
  | { kind: "providerChild"; runId: RunId; childHandle: ChildHandle };
/** Parses an {@link AgentTreeMember}. */
export const AgentTreeMemberSchema: z.ZodType<AgentTreeMember> = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("agent"), agentId: AgentIdSchema }).strict(),
  z
    .object({
      kind: z.literal("providerChild"),
      runId: RunIdSchema,
      childHandle: ChildHandleSchema,
    })
    .strict(),
]);
