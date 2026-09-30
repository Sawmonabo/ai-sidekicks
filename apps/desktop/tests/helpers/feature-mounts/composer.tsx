// The composer feature's views, mounted once for the two tiers that look at them.
//
// Not a test file — no `include` glob reaches it as one. It lives in `feature-mounts/`
// rather than beside the tier harnesses, because the two tiers that mount it are two
// directories and a module named for one feature belongs with the other feature mounts.
// The screenshot tier and the accessibility tier need the same compositions, and a
// per-tier copy of the mount would be two chances to compose them differently and then
// read the results as if they were comparable. `app-harness.ts` owns HOW the app is mounted, one
// level down; this owns WHAT of this feature is mounted into it.
//
// THE COMPOSER STATES ARE ADDRESSES, NOT VARIANTS. `chip-models.ts` resolves the send
// path from the FOCUSED PANE and the session store's own partitions, so the composer
// has no state to be put into — it has an address to be read at. The three below are
// therefore three `focusedPane` values (and, for the two provider-bound ones, two
// different prefixes of the same scenario log), which is why they share one store
// builder and differ in one argument each:
//
//   • the session's own default, which is what a composer addresses when focus is not
//     in the pane layout;
//   • the provider-bound path with the run still `running`;
//   • the provider-bound path with the run `waiting_for_input`, which is where the
//     composer scenario ends and the one state the design calls "steer".
//
// EVERY PARTITION IS THE REAL ONE, because every store here opens with the fold the
// window composes — {@link COMPOSED_ENTITY_PROJECTORS}, and never a registrar this
// file picked. A mount that named its own would be deciding which partitions its
// view can read.
//
// AND EVERY VIEW HERE READS, SO EVERY VIEW HERE SETTLES ITS READS —
// {@link mountViewSettled} is the one seam that does it, rather than each mount
// remembering to. Each of these compositions arms at least one `RefreshScheduler` on
// the fixture's frozen clock, and `renderSettled` moves no clock: without the advance
// the scheduled reads never perform at all, and both tiers photograph an in-flight
// phase under a name that claims to be the answered composition. The settlement is
// then ASSERTED rather than assumed — see {@link requireNoReadInFlight} — because a
// capture of a skeleton is a green case in both tiers.

import type { ReactElement } from "react";

import { renderSettled } from "../app-harness.js";
import { WAITING_FOR_INPUT_SCENARIO } from "../../../fixtures/scenarios/waiting-for-input.js";
import {
  createFixtureBridge,
  type FixtureBridge,
} from "@renderer/services/platform/platform-bridge.fixture.js";
import { FixtureBridgeProvider } from "../app-frame-fixtures.js";
import { settleScheduledRead } from "../scheduled-read.js";
import { MAXIMUM_LIVE_DRAFT_COUNT } from "@renderer/store/persistence-caps.js";
import { DraftStore } from "@renderer/store/draft-store.js";
import { WindowStore } from "@renderer/store/window/window-store.js";
import { SessionStore } from "@renderer/store/session/session-store.js";
import { type ProjectedSessionEvent } from "@renderer/store/session/entities/entities.js";
import { MessageComposer } from "@renderer/features/composer/Composer.js";
import type { PaneAddress } from "@renderer/routing/panes/pane-address.js";
import { COMPOSED_ENTITY_PROJECTORS } from "./projector-composition.js";
import { type MountedView } from "./mount-queries.js";

/**
 * The composer scenario's own agent, read out of the log rather than restated.
 *
 * A second copy of the UUID here would be a constant that agrees with the scenario
 * only by discipline, and the day the scenario's agent changed this mount would go
 * on addressing an agent nobody attached — resolving the session path and capturing
 * a baseline of the wrong composition under the provider-bound name.
 */
function composerAgentId(): string {
  const attached = WAITING_FOR_INPUT_SCENARIO.beats.find(
    (beat) => beat.event.kind === "agent.attached",
  );
  const agentId = attached?.event.payload?.["agentId"];
  if (typeof agentId !== "string") {
    throw new Error("the composer scenario attaches no agent, so no provider-bound address exists");
  }
  return agentId;
}

/**
 * A store holding the scenario's beats up to and including the named kind.
 *
 * A PREFIX rather than the whole log, because the two provider-bound views differ
 * only in how far the run has got: feeding both the whole log would capture the same
 * composition twice under two names and report the pair as covering two states.
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
 * Mount one view, let its scheduled reads answer, and prove that they did.
 *
 * THE SEAM RATHER THAN EACH MOUNT, because "remember to advance the clock" is a rule
 * a sixth view added to this file would not know about. `renderSettled` owns the
 * promise flush and moves no clock; every composition here arms a `RefreshScheduler`
 * on the scenario's frozen one, so the advance is not an option a mount takes but the
 * second half of what settling MEANS for a view that reads.
 *
 * The absolute deadline is `settleScheduledRead`'s to spend, not this file's — which
 * is why the constant it advances by is not imported here any more.
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
 * Throw if anything in the mounted tree is still reporting a read in flight.
 *
 * THE PREDICATE IS THE ONE ASSISTIVE TECHNOLOGY READS, and that is deliberate: the
 * console's `not-loaded` absence is the only thing it renders with `aria-busy`, so
 * this asks the tree the same question a screen reader does rather than restating a
 * class name the primitive composes. A capture taken while one is up photographs a
 * skeleton under a name that claims to be the answered composition, and both tiers
 * that mount these views would pass on it — the screenshot tier by minting the
 * skeleton as its reference, the accessibility tier by auditing a view whose
 * controls have not been offered yet.
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
  return { element: requireRegion(container, "Message composer"), bridge };
}

/** The composer with focus outside the pane layout: addressed at the session. */
export async function mountComposerSessionDefault(): Promise<MountedView> {
  return mountComposerAt({ throughKind: "run.running", focusedPane: undefined });
}

/** The composer addressed at a working run: the new-turn path against a live agent. */
export async function mountComposerProviderBoundRunning(): Promise<MountedView> {
  return mountComposerAt({
    throughKind: "run.running",
    focusedPane: { kind: "agents", entity: { kind: "agent", id: composerAgentId() } },
  });
}

/** The composer addressed at a run waiting on a person: the steer path. */
export async function mountComposerProviderBoundWaiting(): Promise<MountedView> {
  return mountComposerAt({
    throughKind: "run.waiting_for_input",
    focusedPane: { kind: "agents", entity: { kind: "agent", id: composerAgentId() } },
  });
}

/**
 * Find the one element a view renders itself as.
 *
 * Scoped by accessible name rather than by class, because that is what a person
 * using assistive technology navigates by — a view that lost its accessible name
 * would still match a class selector and would still be captured as if nothing had
 * changed.
 */
function requireRegion(container: HTMLElement, accessibleName: string): HTMLElement {
  const region = container.querySelector(`[aria-label="${accessibleName}"]`);
  if (!(region instanceof HTMLElement)) {
    throw new Error(`nothing in the mounted tree is labeled \`${accessibleName}\``);
  }
  return region;
}
