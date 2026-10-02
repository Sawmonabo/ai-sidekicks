// Builds the context every settings-page suite hands its page, so a member added to
// `SettingsPageContext` is one compile error in one file.

import { type PlatformBridge } from "@renderer/services/platform/platform-bridge.js";
import { MemoryPersistenceAdapter } from "@renderer/store/persistence/memory-persistence-adapter.js";
import { UiStateStore } from "@renderer/store/persistence/ui-state-store.js";
import { SessionStore } from "@renderer/store/session/session-store.js";
import type { MainProcessState } from "@shared/daemon-status-topic.js";
import { UNREPORTED_MAIN_PROCESS_STATE } from "@renderer/store/window/main-process-state.js";
import type { SettingsPageContext } from "@renderer/features/settings/types.js";

/**
 * What a case says about the window its page is mounted in, where it says anything.
 *
 * Named rather than positional: each member is a context axis most pages do not read, and a
 * positional tail would force placeholders for the earlier ones, two of which are defaulted
 * values a reader could not tell from "this case meant `undefined`".
 */
export interface SettingsPageContextOverrides {
  readonly retainedSessionStore?: SessionStore | undefined;
  readonly mainProcessState?: MainProcessState | undefined;
  readonly selection?: string | undefined;
  readonly uiStateStore?: UiStateStore | undefined;
}

/**
 * The context a settings page is handed, over a bridge and a retained session.
 *
 * `retainedSessionId` is required, not an override, because `undefined` is the window that has
 * opened no session and a default would answer those cases with a session id. `mainProcessState`
 * defaults to the seeded unreported value, not a healthy one; a case rendering a degraded arm
 * names its own. `selection` defaults to absent, as when a page is reached from the settings
 * rail; a deep-link case names its own. `uiStateStore` defaults to a fresh
 * {@link testUiStateStore}.
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
    uiStateStore: overrides.uiStateStore ?? testUiStateStore(),
    chooseScheme: () => undefined,
  } satisfies SettingsPageContext;
}

/**
 * A store every settings-page case can be handed, on the adapter that says so.
 *
 * The memory adapter and not a stub: it is the app's own fallback, reports `durable: false`
 * with a reason from the same table the durable path reads, and reproduces failures a real disk
 * would take a real disk to produce. A fresh store per call, because the health counts
 * are cumulative and two cases sharing one would read each other's refusals.
 */
function testUiStateStore(
  adapter: MemoryPersistenceAdapter = new MemoryPersistenceAdapter(),
): UiStateStore {
  return new UiStateStore({ adapter });
}
