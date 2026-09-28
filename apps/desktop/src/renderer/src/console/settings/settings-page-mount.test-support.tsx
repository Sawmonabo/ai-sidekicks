// How every settings-page suite builds the context its page reads, and mounts a
// registered page.
//
// ONE CONTEXT BUILDER FOR THE FAMILY. `SettingsPageContext` is the shape every page
// in this family is handed, so a member added to it has to reach every harness that
// builds one: the builder is here, and a new member is one compile error in one file.
//
// AND ONE RESOLUTION OF A REGISTERED PAGE'S DEFERRED BODY. Every settings registration
// this console ships takes the registry's LOADER form, so a suite that renders a page
// through the board it is registered on has to preload the chunk, resolve the descriptor,
// mount it inside the announcer, and settle the reads the body puts in flight. The pair
// below is that sequence and its other half: the reservation the same registration draws
// BEFORE the chunk lands, which is what makes the awaited case a claim about a body that
// landed rather than about one that was there all along. `test/console/surfaces/
// pane-body-resolution.ts` is the same rule on the two boards in `seats/`; this is that
// rule on the settings board, which is the settings family's own.

import { render } from "@testing-library/react";

import { consoleClockFor, type ConsoleBridge } from "../bridge/index.js";
import { MemoryPersistenceAdapter, UiStateStore } from "../persistence/index.js";
import { LiveAnnouncerProvider } from "../primitives/index.js";
import { SessionStore, UNREPORTED_SHELL_STATE, type ShellState } from "../store/index.js";
import { settle } from "../core/settle.test-support.js";
// The scheduler wait by its own leaf specifier: a family door publishes what a
// PRODUCTION module reads, and the barrel census fails a line written for a harness.
import { settleScheduledRead } from "../bridge/readings/scheduled-read.test-support.js";
import {
  SettingsPageRegistry,
  type SettingsPageBody,
  type SettingsPageContext,
  type SettingsPageRegistrar,
} from "./settings-page-registry.js";
import { type SettingsSectionId } from "./settings-sections.js";

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
  readonly shellState?: ShellState | undefined;
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
 * {@link consoleTestUiStateStore} for why the real one and not a double, and why one
 * per call.
 */
export function settingsPageContextWith(
  bridge: ConsoleBridge,
  retainedSessionId: string | undefined,
  overrides: SettingsPageContextOverrides = {},
): SettingsPageContext {
  return {
    bridge,
    openSection: () => undefined,
    selection: overrides.selection,
    retainedSessionId,
    retainedSessionStore: overrides.retainedSessionStore,
    shellState: overrides.shellState ?? UNREPORTED_SHELL_STATE,
    uiStateStore: overrides.uiStateStore ?? consoleTestUiStateStore(),
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
export function consoleTestUiStateStore(
  adapter: MemoryPersistenceAdapter = new MemoryPersistenceAdapter(),
): UiStateStore {
  return new UiStateStore({ adapter });
}

/**
 * A registered settings page, its chunk resolved and its first reads settled.
 *
 * THE CHUNK IS AWAITED THROUGH THE REGISTRATION'S OWN LOADER, never by settling
 * generously. `preload` is that loader, memoised, so awaiting it is exact: a
 * component-form registration has nothing to load and settles immediately, and a
 * loader-backed one is resolved before the first render rather than one frame into it.
 * A dynamic import needs more than the one macrotask a render settle crosses, so a
 * mount that settled twice and passed would be a mount that raced.
 *
 * AND THE FROZEN CLOCK IS MOVED, not just the microtask queue. Every read this console
 * performs goes through `store/read/refresh-scheduler.ts`'s one `RefreshScheduler`, armed on the
 * bridge's frozen clock — so a mount that only drained promises would hand a case a page
 * that had never been given the chance to ask, and the case would read the "still
 * reading" arm as the answer. `settleScheduledRead` is the console's one home for that
 * wait, and it is taken unconditionally: it throws where the bridge carries no frozen
 * clock, which is a defect in the case rather than a variant of this mount, since such a
 * bridge cannot settle the page's reads at all.
 */
export async function mountRegisteredSettingsPage(
  section: SettingsSectionId,
  registerPage: (registrar: SettingsPageRegistrar) => void,
  context: SettingsPageContext,
): Promise<HTMLElement> {
  const registry = registryWith(registerPage);
  await registry.preload(section);
  const container = mountPageBody(bodyFor(registry, section), context);
  await settle();
  await settleScheduledRead(context.bridge);
  return container;
}

/**
 * The same registration BEFORE its chunk lands: the region it reserves.
 *
 * The other side of the loader form, and the negative control for the wait above — an
 * unpreloaded descriptor draws the reservation, so a case that mounted through
 * {@link mountRegisteredSettingsPage} is asserting on a body that arrived rather than on
 * one that was there all along. It is also the frame a person sees, and it must carry
 * the pending marker: the screenshot tier refuses to photograph a tree holding one, and
 * a settings page mid-load is exactly what that refusal exists for.
 *
 * SYNCHRONOUS, AND THAT IS THE CLAIM ITSELF. The reservation is the render that happens
 * before the import resolves, so a mount that settled first would be asking about a body
 * that had already landed — under Vitest the module graph is already transformed and one
 * settle is enough for it to.
 */
export function mountReservedSettingsPage(
  section: SettingsSectionId,
  registerPage: (registrar: SettingsPageRegistrar) => void,
  context: SettingsPageContext,
): HTMLElement {
  return mountPageBody(bodyFor(registryWith(registerPage), section), context);
}

/**
 * The registry one case owns, with the page registered on it.
 *
 * A scoped registry per call rather than one shared instance, for the registrar's own
 * reason: the table is owner-scoped state, so two cases sharing one would make the
 * second depend on whether the first had run.
 *
 * The page arrives as its own REGISTRAR rather than as a descriptor, so what a case
 * drives is the shipped registration — a registrar that claimed nothing fails here,
 * where the message names the section, instead of rendering an empty pane.
 */
function registryWith(
  registerPage: (registrar: SettingsPageRegistrar) => void,
): SettingsPageRegistry {
  const registry = new SettingsPageRegistry();
  registerPage(registry);
  return registry;
}

/** The body a registration claims for a section, or a failure that names the section. */
function bodyFor(registry: SettingsPageRegistry, section: SettingsSectionId): SettingsPageBody {
  const descriptor = registry.descriptorFor(section);
  if (descriptor === undefined) {
    throw new Error(`no settings page is registered for the \`${section}\` section`);
  }
  return descriptor.render;
}

/**
 * Mount one page inside the announcer, on the clock its own bridge schedules against.
 *
 * The announcer is part of the mount rather than a case's decoration: a settings page
 * that settles an act says so, and `useAnnounce` throws outside the provider
 * deliberately — so a mount that omitted it would fail inside a page and report a
 * missing live region as a broken settings section.
 *
 * ITS CLOCK IS THE BRIDGE'S, resolved by the shipped `consoleClockFor` rather than
 * chosen here. The announcer arms a timeout, and the fixture clock is the only clock
 * the renderer reads in fixture mode — so a
 * harness that minted a clock of its own would arm the hold on a clock no case can
 * move, and one that passed none would arm it on the wall.
 */
function mountPageBody(body: SettingsPageBody, context: SettingsPageContext): HTMLElement {
  const { container } = render(
    <LiveAnnouncerProvider clock={consoleClockFor(context.bridge)}>
      {body(context)}
    </LiveAnnouncerProvider>,
  );
  return container;
}
