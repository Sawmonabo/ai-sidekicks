// Builds the context every settings-page suite hands its page, so a member added to
// `SettingsPageContext` is one compile error in one file.

import { type PlatformBridge } from "@renderer/services/platform/platform-bridge.js";
import { SessionStore } from "@renderer/store/session/session-store.js";
import type { MainProcessState } from "@shared/daemon/daemon-status-topic.js";
import { UNREPORTED_MAIN_PROCESS_STATE } from "@renderer/store/window/main-process-state.js";
import type { SettingsPageContext } from "@renderer/features/settings/types.js";

/**
 * What a case says about the window its page is mounted in, where it says anything.
 *
 * Named rather than positional: each member is a context axis most pages do not read, and a
 * positional tail would force placeholders for the earlier ones, one of which is a defaulted
 * value a reader could not tell from "this case meant `undefined`".
 */
export interface SettingsPageContextOverrides {
  readonly retainedSessionStore?: SessionStore | undefined;
  readonly mainProcessState?: MainProcessState | undefined;
  readonly selection?: string | undefined;
}

/**
 * The context a settings page is handed, over a bridge and a retained session.
 *
 * `retainedSessionId` is required, not an override, because `undefined` is the window that has
 * opened no session and a default would answer those cases with a session id. `mainProcessState`
 * defaults to the seeded unreported value, not a healthy one; a case rendering a degraded arm
 * names its own. `selection` defaults to absent, as when a page is reached from the settings
 * rail; a deep-link case names its own.
 */
export function settingsPageContextWith(
  bridge: PlatformBridge,
  retainedSessionId: string | undefined,
  overrides: SettingsPageContextOverrides = {},
): SettingsPageContext {
  return {
    bridge,
    openPage: () => undefined,
    selection: overrides.selection,
    retainedSessionId,
    retainedSessionStore: overrides.retainedSessionStore,
    mainProcessState: overrides.mainProcessState ?? UNREPORTED_MAIN_PROCESS_STATE,
    chooseScheme: () => undefined,
  } satisfies SettingsPageContext;
}
