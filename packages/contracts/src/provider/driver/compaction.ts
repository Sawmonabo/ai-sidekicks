// The result of a provider's compaction, composed by the daemon from the wait's own settlement.
import { z } from "zod";

/**
 * The result of a compaction attempt. `applied` only after the provider's compaction frame was
 * seen; `refused` means nothing was sent; `failed` means something was sent and no boundary came.
 */
export type DriverCompactionResult =
  // `boundaryPosition` is `null` where the provider's frame carried none.
  | { status: "applied"; boundaryPosition: number | null }
  // `command_absent`: the provider's own list for this binding lacks the command.
  // `not_permitted`: the daemon's permission check denied the caller; never a driver's.
  | { status: "refused"; reason: "command_absent" | "not_permitted" }
  // `wait_expired`: no compaction frame within the binding's bound. `binding_lost`: the binding
  // ended first. `provider_error`: the provider's mechanism errored.
  | { status: "failed"; reason: "wait_expired" | "binding_lost" | "provider_error" };

/** Validates a {@link DriverCompactionResult}; `applied` needs a `boundaryPosition` key. */
export const DriverCompactionResultSchema: z.ZodType<
  DriverCompactionResult,
  DriverCompactionResult
> = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("applied"),
      // `.nullable()`, not `.optional()`: null states that the provider's frame carried no
      // position, while an absent key would look like a driver that forgot to report one.
      boundaryPosition: z.number().int().min(0).nullable(),
    })
    .strict(),
  z
    .object({
      status: z.literal("refused"),
      reason: z.enum(["command_absent", "not_permitted"]),
    })
    .strict(),
  z
    .object({
      status: z.literal("failed"),
      reason: z.enum(["wait_expired", "binding_lost", "provider_error"]),
    })
    .strict(),
]);
