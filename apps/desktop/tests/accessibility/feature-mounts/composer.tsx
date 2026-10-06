// The composer feature's views, mounted once for the accessibility tier.
//
// Not a test file. `helpers/app/harness.ts` owns how the app is mounted; this owns what of this
// feature is mounted into it.
//
// The composer states are addresses, not variants: `features/composer/target.ts` resolves the send
// path from the focused pane and the session store's own partitions, so the composer has an address
// to be read at, not a state to be put into. The three mounts are three `focusedPane` values (and,
// for the two provider-bound ones, two prefixes of the same scenario log), so they share one store
// builder:
//
//   • the session default, which a composer addresses when focus is not in the pane layout;
//   • the provider-bound path with the run `running`;
//   • the provider-bound path with the run `waiting_for_input`, the steer path.
//
// Every store opens with the fold the window composes ({@link COMPOSED_ENTITY_PROJECTORS}), never
// a registrar this file picked, which would decide which partitions its view can read.
//
// Every view here reads, so every view settles its reads through {@link mountViewSettled}: each
// composition arms a `RefreshScheduler` on the fixture's frozen clock and `renderSettled` moves no
// clock, so without the advance the scheduled reads never perform and the tier audits an
// in-flight phase. The settlement is asserted ({@link requireNoReadInFlight}) because an audit of
// a skeleton is a green case.

import type { ReactElement } from "react";

import { renderSettled } from "../../helpers/app/harness.js";
import { WAITING_FOR_INPUT_SCENARIO } from "#fixtures/scenarios/waiting-for-input.js";
import { scenarioLeadAgentId } from "#fixtures/data/opening-entries.js";
import {
  createFixtureBridge,
  type FixtureBridge,
} from "#renderer/services/platform/bridge.fixture.js";
import { FixtureBridgeProvider } from "../../helpers/app/frame-fixtures.js";
import { settleScheduledRead } from "../../helpers/scheduled-read.js";
import { MAXIMUM_LIVE_DRAFT_COUNT } from "#renderer/store/persistence/caps.js";
import { DraftStore } from "#renderer/store/drafts.js";
import { WindowStore } from "#renderer/store/window/store.js";
import { SessionStore } from "#renderer/store/session/store.js";
import { type ProjectedSessionEvent } from "#renderer/store/session/entities/vocabulary.js";
import { MessageComposer } from "#renderer/features/composer/Composer.js";
import type { PaneAddress } from "#renderer/routing/panes/address.js";
import { COMPOSED_ENTITY_PROJECTORS } from "./projector-composition.js";
import { requireLabeledRegion, type MountedView } from "./mount-queries.js";

/**
 * A store holding the scenario's beats up to and including the named kind.
 *
 * A prefix rather than the whole log, because the two provider-bound views differ only in how far
 * the run has got.
 */
function composerSessionStore(throughKind: string): SessionStore {
  const store = new SessionStore({
    sessionId: WAITING_FOR_INPUT_SCENARIO.sessionId,
    projectors: COMPOSED_ENTITY_PROJECTORS,
  });
  store.initialize({ cursor: 0, entities: [] });
  const lastIndex = WAITING_FOR_INPUT_SCENARIO.beats.findLastIndex(
    (beat) => beat.event.kind === throughKind,
  );
  if (lastIndex < 0) {
    throw new Error(`the composer scenario plays no \`${throughKind}\` beat`);
  }
  store.applyBatch(
    WAITING_FOR_INPUT_SCENARIO.beats
      .slice(0, lastIndex + 1)
      .map((beat) => beat.event as ProjectedSessionEvent),
  );
  return store;
}

/**
 * Mounts one view, lets its scheduled reads answer, and proves that they did.
 *
 * A seam rather than a step in each mount, so a view added later cannot forget to advance the
 * clock: `renderSettled` moves no clock, and every composition here arms a `RefreshScheduler` on
 * the scenario's frozen one. The absolute deadline is `settleScheduledRead`'s.
 */
async function mountViewSettled(
  fixture: FixtureBridge,
  element: ReactElement,
): Promise<HTMLElement> {
  const { container } = await renderSettled(
    <FixtureBridgeProvider fixture={fixture}>{element}</FixtureBridgeProvider>,
  );
  await settleScheduledRead(fixture.scenarioEngine.clock);
  requireNoReadInFlight(container);
  return container;
}

/**
 * Throws if anything in the mounted tree still reports a read in flight.
 *
 * Asks the question a screen reader does: the `not-loaded` absence is the only thing rendered
 * with `aria-busy`. With one up the accessibility tier would audit a skeleton before the controls
 * are offered.
 */
function requireNoReadInFlight(container: HTMLElement): void {
  const inFlight = [...container.querySelectorAll('[aria-busy="true"]')];
  if (inFlight.length === 0) {
    return;
  }
  throw new Error(
    `${String(inFlight.length)} read(s) were still in flight after the view settled: ${inFlight
      .map((element) => element.textContent ?? element.className)
      .join(" | ")}`,
  );
}

/** Mount the composer at one address, over a store fed to one point in the log. */
async function mountComposerAt(options: {
  readonly throughKind: string;
  readonly focusedPane: PaneAddress | undefined;
}): Promise<MountedView> {
  const fixture = createFixtureBridge({ scenario: WAITING_FOR_INPUT_SCENARIO });
  const { bridge } = fixture;
  const container = await mountViewSettled(
    fixture,
    <MessageComposer
      sessionStore={composerSessionStore(options.throughKind)}
      bridge={bridge}
      draftStore={new DraftStore({ maximumDraftCount: MAXIMUM_LIVE_DRAFT_COUNT })}
      frameStore={new WindowStore()}
      route={{ kind: "session", sessionId: WAITING_FOR_INPUT_SCENARIO.sessionId }}
      focusedPane={options.focusedPane}
    />,
  );
  return { element: requireLabeledRegion(container, "Message composer"), bridge };
}

/** The composer with focus outside the pane layout: addressed at the session. */
export async function mountComposerSessionDefault(): Promise<MountedView> {
  return mountComposerAt({ throughKind: "run.running", focusedPane: undefined });
}

/** The composer addressed at a working run: the new-turn path against a live agent. */
export async function mountComposerProviderBoundRunning(): Promise<MountedView> {
  return mountComposerAt({
    throughKind: "run.running",
    focusedPane: {
      kind: "agents",
      entity: { kind: "agent", id: scenarioLeadAgentId(WAITING_FOR_INPUT_SCENARIO) },
    },
  });
}

/** The composer addressed at a run waiting on a person: the steer path. */
export async function mountComposerProviderBoundWaiting(): Promise<MountedView> {
  return mountComposerAt({
    throughKind: "run.waiting_for_input",
    focusedPane: {
      kind: "agents",
      entity: { kind: "agent", id: scenarioLeadAgentId(WAITING_FOR_INPUT_SCENARIO) },
    },
  });
}
