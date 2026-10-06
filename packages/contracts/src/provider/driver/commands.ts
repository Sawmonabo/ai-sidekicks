// The provider-command enumeration a client reads: each command, skill or tool server prompt the
// provider listed, grouped by the binding it was read under.
import { z } from "zod";

import { wireFreeFormString } from "../../free-form-string.js";
import { type RunId } from "../../run/id.js";
import { ProviderNameSchema, type ProviderName } from "../name.js";
import {
  DRIVER_MCP_SERVER_NAME_MAX_LEN,
  DRIVER_PROVIDER_COMMAND_DESCRIPTION_MAX_LEN,
  DRIVER_PROVIDER_COMMAND_NAME_MAX_LEN,
  DRIVER_PROVIDER_DECLARED_TOKEN_MAX_LEN,
} from "./length-limits.js";

/**
 * The binding a provider-command enumeration was read under: the `(driverName, providerAccountId)`
 * routing pair a group and each of its entries carry. `providerAccountId` is `null` when the
 * session bound no account.
 */
export interface ProviderCommandBinding {
  driverName: ProviderName;
  providerAccountId: string | null;
}

/** Validates a {@link ProviderCommandBinding}. Strict: an unknown key is a driver bug. */
export const ProviderCommandBindingSchema: z.ZodType<
  ProviderCommandBinding,
  ProviderCommandBinding
> = z
  .object({
    driverName: ProviderNameSchema,
    // Nullable, not `.optional()`: an account-less session is real (the account registry is a
    // spawn-time binding not every leg carries) and `null` states that none was bound. An absent
    // key would look like a driver that forgot to report one, and a placeholder (`""`, "unknown",
    // the driver name) would make the routing invariant unenforceable while looking enforced,
    // since two account-less bindings on different providers would compare equal on the half of
    // the pair meant to separate them.
    //
    // `null` matches nothing, never a wildcard: an account-less enumeration can be read but never
    // used to route a dispatch onto another binding. That is the consumer's obligation, not
    // something this schema enforces. A driver also reports `null` when it has no reader for the
    // account registry (neither establishment params object carries an account id); the
    // obligation reads the same on both, so neither authorizes a dispatch onto another binding.
    providerAccountId: z.string().min(1).nullable(),
  })
  .strict();

/**
 * One enumerated provider command, skill or working tool server's prompt, as the provider
 * listed it: a disabled entry is returned, not dropped, and `binding` is its routing key.
 */
export interface ProviderCommandEntry {
  name: string;
  // Distinguishes the things published under one syntax: a provider's command, a skill, and a
  // working tool server's prompt.
  kind: "command" | "skill" | "prompt";
  // Omitted, never an empty string, when the provider publishes none. Codex types a skill's
  // description as required, so a skill with none arrives as "", which the schema's
  // `wireFreeFormString` rejects; forwarding it verbatim would fail the enumeration on an honest
  // reading. Omission also says the truth: no description was published, not a blank one.
  description?: string | undefined;
  // The provider's own hint for what follows the word, present only where it publishes one.
  argumentHint?: string | undefined;
  // Present only where the provider declares one (Codex skills do; the Claude handshake
  // enumeration does not), so absence means no scope was stated, never that it is unknown.
  scope?: string | undefined;
  // Present iff the provider declares one (Codex `skills/list` carries an `enabled` Boolean; the
  // Claude handshake enumeration draws no such distinction). Absent means the provider draws no
  // distinction, never an unknown state, and never a driver-synthesized `true`.
  enabled?: boolean | undefined;
  // The tool server that publishes a prompt, which the list groups it under; present exactly on a
  // `prompt` entry.
  server?: string | undefined;
  binding: ProviderCommandBinding;
}

/**
 * Validates a {@link ProviderCommandEntry}. Strict, siding with the result envelopes: the driver
 * builds it from what its provider published, so an unknown key is a driver bug. Every
 * provider-authored string is `wireFreeFormString`-bounded because a local skill file's front
 * matter is the person's to write and the assembled list travels to a client.
 */
export const ProviderCommandEntrySchema: z.ZodType<ProviderCommandEntry, ProviderCommandEntry> = z
  .object({
    name: wireFreeFormString(DRIVER_PROVIDER_COMMAND_NAME_MAX_LEN, "ProviderCommandEntry.name"),
    kind: z.enum(["command", "skill", "prompt"]),
    description: wireFreeFormString(
      DRIVER_PROVIDER_COMMAND_DESCRIPTION_MAX_LEN,
      "ProviderCommandEntry.description",
    ).optional(),
    argumentHint: wireFreeFormString(
      DRIVER_PROVIDER_COMMAND_DESCRIPTION_MAX_LEN,
      "ProviderCommandEntry.argumentHint",
    ).optional(),
    scope: wireFreeFormString(
      DRIVER_PROVIDER_DECLARED_TOKEN_MAX_LEN,
      "ProviderCommandEntry.scope",
    ).optional(),
    enabled: z.boolean().optional(),
    server: wireFreeFormString(
      DRIVER_MCP_SERVER_NAME_MAX_LEN,
      "ProviderCommandEntry.server",
    ).optional(),
    binding: ProviderCommandBindingSchema,
  })
  .strict()
  .refine((entry) => (entry.kind === "prompt") === (entry.server !== undefined), {
    message: "server is present exactly on a prompt entry",
    path: ["server"],
  });

/**
 * One live binding's command list, with where it came from. `complete: false` means the provider
 * listed more entries than the per-group cap and the tail was dropped.
 */
export interface ProviderCommandBindingGroup {
  // The one live run on the binding; `null` when none or several are live.
  runId: RunId | null;
  binding: ProviderCommandBinding;
  entries: ProviderCommandEntry[];
  complete: boolean;
}

/**
 * The reply of `listProviderCommands`: one group per live binding, so each entry keeps where it
 * came from. A driver returns exactly one group; the daemon concatenates an agent's groups.
 */
export interface ProviderCommandListResult {
  bindings: ProviderCommandBindingGroup[];
}
