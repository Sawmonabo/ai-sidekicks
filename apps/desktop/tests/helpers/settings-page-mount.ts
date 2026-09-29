// How every settings-page suite builds the context its page reads.
//
// `SettingsPageContext` is the shape every page in this family is handed, so a member added
// to it has to reach every harness that builds one: the builder is here, and a new member is
// one compile error in one file.

import { type ConsoleBridge } from "@renderer/services/platform/platform-bridge.js";
import { MemoryPersistenceAdapter } from "@renderer/store/persistence/memory-persistence-adapter.js";
import { UiStateStore } from "@renderer/store/persistence/ui-state-store.js";
import { SessionStore } from "@renderer/store/session/session-store.js";
import {
  UNREPORTED_MAIN_PROCESS_STATE,
  type MainProcessState,
} from "@renderer/store/window/main-process-state.js";
import type { SettingsPageContext } from "@renderer/features/settings/types.js";

/**
 * What a case says about the window its page is mounted in, where it says anything.
 *
 * NAMED RATHER THAN POSITIONAL, and that is the shape rather than a preference. Every
 * member here is a context axis some page reads and most pages do not, so a positional
 * tail would make a case naming the last of them write placeholders for the ones
 * before it — and two of these are defaulted values, which is exactly the position a
 * reader cannot tell apart from "this case meant `undefined`".
 */
export interface SettingsPageContextOverrides {
  readonly retainedSessionStore?: SessionStore | undefined;
  readonly shellState?: MainProcessState | undefined;
  readonly selection?: string | undefined;
  readonly uiStateStore?: UiStateStore | undefined;
}

/**
 * The context a settings page is handed, over a bridge and a retained session.
 *
 * `retainedSessionId` is a required parameter and not an override: `undefined` is the
 * window that has opened no session, which several cases exist to drive, and a default
 * would silently answer those with a session id instead.
 *
 * `shellState` defaults to the seeded unreported value rather than to a healthy one: a
 * page mounted by a case that says nothing about the shell is a page in a window nobody
 * has told anything.
 * A case that renders a degraded arm names its own.
 *
 * `selection` is absent for the same reason and to the same effect: a page reached from
 * the settings rail was opened for nothing in particular, which is how most of it is
 * reached. A case driving the deep link names its own subject.
 *
 * `uiStateStore` defaults to a fresh memory-backed store — see
 * {@link testUiStateStore} for why the real one and not a double, and why one
 * per call.
 */
export function settingsPageContextWith(
  bridge: ConsoleBridge,
  retainedSessionId: string | undefined,
  overrides: SettingsPageContextOverrides = {},
): SettingsPageContext {
  return {
    bridge,
    openPage: () => undefined,
    selection: overrides.selection,
    retainedSessionId,
    retainedSessionStore: overrides.retainedSessionStore,
    shellState: overrides.shellState ?? UNREPORTED_MAIN_PROCESS_STATE,
    uiStateStore: overrides.uiStateStore ?? testUiStateStore(),
    chooseScheme: () => undefined,
  } satisfies SettingsPageContext;
}

/**
 * A store every settings-page case can be handed, on the adapter that says so.
 *
 * The memory adapter and not a stub: it is the one the console itself falls back to,
 * it reports `durable: false` with a reason from the same table the durable path
 * reads, and it is exported for exactly this — a case driving a failure a real disk
 * would take a real disk to reproduce. A hand-written double would be a second
 * answer to what a store does, and the page reporting the store's state would then
 * be tested against a fiction.
 *
 * A fresh one per call, because the health ledger's counts are cumulative for the
 * store's lifetime: two cases sharing one store would read each other's refusals.
 */
export function testUiStateStore(
  adapter: MemoryPersistenceAdapter = new MemoryPersistenceAdapter(),
): UiStateStore {
  return new UiStateStore({ adapter });
}
