// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The provider commands a client reads: each command, skill or tool server prompt the provider listed, grouped by the binding it was read under.

import type { RunId } from "../../run/id.js";
import type { ProviderAccountId } from "../account/record.js";
import type { ProviderId } from "../id.js";

/**
 * One command, skill or tool server prompt as the provider listed it, told apart by
 * `kind`: a disabled entry is returned, not dropped, and `binding` is its routing key.
 * `server` is present exactly on a prompt, and `title` only there.
 */
export type ProviderCommandEntry =
  | {
      kind: "command";
      /**
       * The word the person types.
       */
      name: string;
      /**
       * What it does, absent when the provider publishes none.
       */
      description?: string;
      /**
       * The provider's hint for what follows the word, where it publishes one.
       */
      argumentHint?: string;
      /**
       * The scope the provider declares, where it declares one.
       */
      scope?: string;
      /**
       * Whether it is enabled, where the provider draws that distinction.
       */
      enabled?: boolean;
      /**
       * The binding the entry was read under.
       */
      binding: ProviderCommandBinding;
      /**
       * Only a prompt names a server.
       */
      server?: never;
      /**
       * Only a prompt carries a title.
       */
      title?: never;
    }
  | {
      kind: "skill";
      /**
       * The word the person types.
       */
      name: string;
      /**
       * What it does, absent when the provider publishes none.
       */
      description?: string;
      /**
       * The provider's hint for what follows the word, where it publishes one.
       */
      argumentHint?: string;
      /**
       * The scope the provider declares, where it declares one.
       */
      scope?: string;
      /**
       * Whether it is enabled, where the provider draws that distinction.
       */
      enabled?: boolean;
      /**
       * The binding the entry was read under.
       */
      binding: ProviderCommandBinding;
      /**
       * Only a prompt names a server.
       */
      server?: never;
      /**
       * Only a prompt carries a title.
       */
      title?: never;
    }
  | {
      kind: "prompt";
      /**
       * The word the person types.
       */
      name: string;
      /**
       * What it does, absent when the provider publishes none.
       */
      description?: string;
      /**
       * The provider's hint for what follows the word, where it publishes one.
       */
      argumentHint?: string;
      /**
       * The scope the provider declares, where it declares one.
       */
      scope?: string;
      /**
       * Whether it is enabled, where the provider draws that distinction.
       */
      enabled?: boolean;
      /**
       * The binding the entry was read under.
       */
      binding: ProviderCommandBinding;
      /**
       * The tool server that publishes the prompt.
       */
      server: string;
      /**
       * The prompt's title for people, where the server gives one.
       */
      title?: string;
    };

/**
 * The binding a command list was read under: the routing pair a group and each of its entries
 * carry.
 */
export interface ProviderCommandBinding {
  /**
   * The provider.
   */
  providerName: ProviderId;
  /**
   * The account the session's binding runs on.
   */
  providerAccountId: ProviderAccountId;
}
/**
 * One live binding's command list, whole as the provider published it, with where it came from.
 */
export interface ProviderCommandBindingGroup {
  /**
   * The one live run on the binding; `null` when none or several are live.
   */
  runId: RunId | null;
  /**
   * The binding.
   */
  binding: ProviderCommandBinding;
  /**
   * Its entries.
   */
  entries: ProviderCommandEntry[];
}
/**
 * The reply of `provider.command.list`: one group per live binding, so each entry keeps
 * where it came from, and at least one, since an agent with no live binding is refused.
 */
export interface ProviderCommandListResponse {
  /**
   * The groups.
   *
   * @minItems 1
   */
  bindings: [ProviderCommandBindingGroup, ...ProviderCommandBindingGroup[]];
}

export {
  validateProviderCommandBinding,
  validateProviderCommandBindingGroup,
  validateProviderCommandEntry,
  validateProviderCommandListResponse,
} from "../../checks/provider/driver/commands.js";
