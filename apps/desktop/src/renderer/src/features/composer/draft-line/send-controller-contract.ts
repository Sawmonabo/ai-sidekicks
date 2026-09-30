// The contract the send bar consumes and the object the controller is built from. Split from
// `hooks/useSendController.ts` so a component can take the controller's type without importing
// the hook.

import type { PlatformBridge } from "@renderer/services/platform/platform-bridge.js";
import type { Refusal } from "@renderer/lib/refusal.js";
import type { DraftStore } from "@renderer/store/draft-store.js";
import type { ComposerTarget } from "../composer-target.js";
import type { CommandExecutor } from "../types.js";
import type { DraftCaret } from "./draft-line.js";
import type { ComposerSendCalls } from "./send-dispatch.js";
import type { ClientCommandPredicate, ProviderCommandPredicate } from "./send-resolutions.js";

/** Whether the line is accepting text or is locked behind an in-flight dispatch. */
export type SendControllerStatus = "idle" | "sending";

/** Everything the controller is built from, as one object. */
export interface SendControllerDependencies {
  /** Keys the composer's held state; nothing here calls through it. */
  readonly bridge: PlatformBridge;
  readonly calls: ComposerSendCalls;
  readonly target: ComposerTarget;
  readonly draftStore: DraftStore;
  /**
   * Whether a name is a registered client command. Supplied with `commandExecutor` by the
   * command zone: a recognizer without an executor intercepts into a refusal.
   */
  readonly recognizeClientCommand?: ClientCommandPredicate | undefined;
  /**
   * Whether a name is one the bound provider published, for discovery only. Read off the
   * same holder the discovery popover renders from. Absent, a typed provider command is like
   * any other slash word.
   */
  readonly recognizeProviderCommand?: ProviderCommandPredicate | undefined;
  /**
   * Runs a recognized client command. Absent, an intercepted line refuses, since clearing the
   * line would report success for an act nothing performed.
   */
  readonly commandExecutor?: CommandExecutor | undefined;
}

/** Everything the send bar renders and every act it offers. */
export interface SendController {
  readonly text: string;
  readonly placeholder: string;
  readonly status: SendControllerStatus;
  /** The last refusal, composer-side or daemon-side, until the person types again. */
  readonly refusal: Refusal | undefined;
  changeText(next: string): void;
  send(): Promise<void>;
  /** Walk one message older. `false` when the caret is not at the start edge. */
  recallOlder(caret: DraftCaret): boolean;
  /** Walk one message newer. `false` when the caret is not at the end edge. */
  recallNewer(caret: DraftCaret): boolean;
}
