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
  | { status: "refused"; reason: "command_absent" }
  // `binding_lost`: the binding ended before the frame came. `provider_error`: the provider's
  // mechanism errored. `not_compacted`: the provider ended the compaction's turn without
  // compacting, as when there is too little to compact or the compaction itself failed.
  | { status: "failed"; reason: "binding_lost" | "provider_error" | "not_compacted" };

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
      reason: z.literal("command_absent"),
    })
    .strict(),
  z
    .object({
      status: z.literal("failed"),
      reason: z.enum(["binding_lost", "provider_error", "not_compacted"]),
    })
    .strict(),
]);
