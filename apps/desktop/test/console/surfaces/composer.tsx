// The composer family's surfaces, mounted once for the two tiers that look at them.
//
// Not a test file — no `include` glob reaches it as one. It lives under `surfaces/`
// rather than beside the tier harnesses, because the two tiers that mount it are two
// directories and a module named for one family belongs in the directory that holds
// the family mounts, not in the drawer that holds everything. The screenshot tier and the
// accessibility tier need the same compositions, and a per-tier copy of the mount
// would be two chances to compose them differently and then read the results as if
// they were comparable. `console-harness.tsx` owns HOW the console is mounted, one
// level down; this owns WHAT of this family is mounted into it.
//
// THE FOUR COMPOSER STATES ARE ADDRESSES, NOT VARIANTS. `chip-models.ts` resolves
// the send path from the FOCUSED PANE and the session store's own partitions, so
// the composer has no state to be put into — it has an address to be read at. The
// four below are therefore four `focusedPane` values (and, for the two provider-
// bound ones, two different prefixes of the same scenario log), which is why they
// share one store builder and differ in one argument each:
//
//   • the channel path with the session's own default, which is what a composer
//     addresses when focus is not in the deck;
//   • the channel path addressed at a named channel;
//   • the provider-bound path with the run still `running`;
//   • the provider-bound path with the run `waiting_for_input`, which is where the
//     composer scenario ends and the one state the design calls "steer".
//
// EVERY PARTITION IS THE REAL ONE, because every store here opens with the fold the
// window composes — {@link COMPOSED_CONSOLE_PROJECTORS}, and never a registrar this
// file picked. A mount that named its own would be deciding which partitions its
// surface can read, and the approvals mount did exactly that: it registered the
// approval-flow fold alone, so the run partition was empty and the pane's Execution
// boundary section rendered "unknown" over a scenario that stamps a posture on its own
// `run.running` beat. A partition no family projects — the agent binding today — still
// renders as an absence, and that is now the family's wire-true state rather than a
// property of this file's import list.
//
// AND EVERY SURFACE HERE READS, SO EVERY SURFACE HERE SETTLES ITS READS —
// {@link mountSurfaceSettled} is the one seam that does it, rather than each mount
// remembering to. Each of these compositions arms at least one `RefreshScheduler` on
// the fixture's frozen clock, and `renderSettled` moves no clock: without the advance
// the roster read behind the paying-account chip and the capability read behind the
// runs pane's controls never perform at all, and both tiers photograph an in-flight
// phase under a name that claims to be the answered composition. The settlement is
// then ASSERTED rather than assumed — see {@link requireNoReadInFlight} — because a
// capture of a skeleton is a green case in both tiers.

import { act, waitFor } from "@testing-library/react";
import type { FunctionComponent, ReactElement } from "react";

import { renderSettled } from "../console-harness.js";

import { APPROVALS_SCENARIO } from "../../../src/renderer/src/console/bridge/scenario/approvals/approvals.js";
import { COMPOSER_SCENARIO } from "../../../src/renderer/src/console/bridge/scenario/composer/composer.js";
import { RUNS_SCENARIO } from "../../../src/renderer/src/console/bridge/scenario/runs/runs.js";
import {
  createFixtureBridge,
  type ConsoleBridge,
} from "../../../src/renderer/src/console/bridge/index.js";
import { settleScheduledRead } from "../../../src/renderer/src/console/bridge/readings/scheduled-read.test-support.js";
import type { ConsoleScenario } from "../../../src/renderer/src/console/bridge/scenario/runtime/index.js";
import { MAXIMUM_LIVE_DRAFT_COUNT } from "../../../src/renderer/src/console/core/index.js";
import { crossMacrotaskBoundary } from "../../../src/renderer/src/console/core/macrotask-boundary.test-support.js";
import { DraftStore, UiStateStore } from "../../../src/renderer/src/console/persistence/index.js";
import {
  FrameStore,
  SessionStore,
  type ConsoleSessionEvent,
} from "../../../src/renderer/src/console/store/index.js";
import { MessageComposer } from "../../../src/renderer/src/shell/MessageComposer.js";
import { registerApprovalsPane } from "../../../src/renderer/src/console/approvals/index.js";
import { registerRunsPane } from "../../../src/renderer/src/console/runs/index.js";
import {
  ConsolePaneRegistry,
  type ConsolePaneAddress,
  type ConsolePaneContext,
  type PaneKind,
} from "../../../src/renderer/src/console/seats/index.js";
import { resolvedPaneBody } from "./pane-body-resolution.js";
import { COMPOSED_CONSOLE_PROJECTORS } from "./projector-composition.js";

/** The element a tier reads, and the bridge it was mounted against. */
export interface MountedFamilySurface {
  readonly element: HTMLElement;
  readonly bridge: ConsoleBridge;
}

/**
 * The composer scenario's own agent, read out of the log rather than restated.
 *
 * A second copy of the UUID here would be a constant that agrees with the scenario
 * only by discipline, and the day the scenario's agent changed this mount would go
 * on addressing an agent nobody attached — resolving the channel path and capturing
 * a baseline of the wrong composition under the provider-bound name.
 */
function composerAgentId(): string {
  const attached = COMPOSER_SCENARIO.beats.find((beat) => beat.event.kind === "agent.attached");
  const agentId = attached?.event.payload?.["agentId"];
  if (typeof agentId !== "string") {
    throw new Error("the composer scenario attaches no agent, so no provider-bound address exists");
  }
  return agentId;
}

/**
 * A store holding the scenario's beats up to and including the named kind.
 *
 * A PREFIX rather than the whole log, because the two provider-bound surfaces differ
 * only in how far the run has got: feeding both the whole log would capture the same
 * composition twice under two names and report the pair as covering two states.
 */
function composerSessionStore(throughKind: string): SessionStore {
  const store = new SessionStore({
    sessionId: COMPOSER_SCENARIO.sessionId,
    projectors: COMPOSED_CONSOLE_PROJECTORS,
  });
  store.initialise({ cursor: 0, entities: [], userJoinLog: [] });
  const lastIndex = COMPOSER_SCENARIO.beats.findLastIndex(
    (beat) => beat.event.kind === throughKind,
  );
  if (lastIndex < 0) {
    throw new Error(`the composer scenario plays no \`${throughKind}\` beat`);
  }
  store.applyBatch(
    COMPOSER_SCENARIO.beats
      .slice(0, lastIndex + 1)
      .map((beat) => beat.event as ConsoleSessionEvent),
  );
  return store;
}

/**
 * Mount one surface, let its scheduled reads answer, and prove that they did.
 *
 * THE SEAM RATHER THAN EACH MOUNT, because "remember to advance the clock" is a rule
 * a sixth surface added to this file would not know about. `renderSettled` owns the
 * promise flush and moves no clock; every composition here arms a `RefreshScheduler`
 * on the scenario's frozen one, so the advance is not an option a mount takes but the
 * second half of what settling MEANS for a surface that reads.
 *
 * The absolute deadline is `settleScheduledRead`'s to spend, not this file's — which
 * is why the constant it advances by is not imported here any more.
 */
async function mountSurfaceSettled(
  bridge: ConsoleBridge,
  element: ReactElement,
): Promise<HTMLElement> {
  const { container } = await renderSettled(element);
  await settleScheduledRead(bridge);
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
 * that mount these surfaces would pass on it — the screenshot tier by minting the
 * skeleton as its reference, the accessibility tier by auditing a surface whose
 * controls have not been offered yet.
 */
function requireNoReadInFlight(container: HTMLElement): void {
  const inFlight = [...container.querySelectorAll('[aria-busy="true"]')];
  if (inFlight.length === 0) {
    return;
  }
  throw new Error(
    `${String(inFlight.length)} read(s) were still in flight after the surface settled: ${inFlight
      .map((element) => element.textContent ?? element.className)
      .join(" | ")}`,
  );
}

/** Mount the composer at one address, over a store fed to one point in the log. */
async function mountComposerAt(options: {
  readonly throughKind: string;
  readonly focusedPane: ConsolePaneAddress | undefined;
}): Promise<MountedFamilySurface> {
  const bridge = createFixtureBridge({ scenario: COMPOSER_SCENARIO });
  const container = await mountSurfaceSettled(
    bridge,
    <MessageComposer
      sessionStore={composerSessionStore(options.throughKind)}
      bridge={bridge}
      draftStore={new DraftStore({ maximumDraftCount: MAXIMUM_LIVE_DRAFT_COUNT })}
      frameStore={new FrameStore()}
      route={{ kind: "workspace", sessionId: COMPOSER_SCENARIO.sessionId }}
      focusedPane={options.focusedPane}
    />,
  );
  return { element: requireRegion(container, "Message composer"), bridge };
}

/** The composer with focus outside the deck: the session's own default channel. */
export async function mountComposerChannelDefault(): Promise<MountedFamilySurface> {
  return mountComposerAt({ throughKind: "run.running", focusedPane: undefined });
}

/** The composer addressed at a named channel rather than at the session default. */
export async function mountComposerChannelAddressed(): Promise<MountedFamilySurface> {
  return mountComposerAt({
    throughKind: "run.running",
    focusedPane: {
      kind: "timeline",
      // A channel the store holds no entity for, which is the ordinary case on this
      // branch: no channel projector is registered, so the chip states that it read
      // no label for the channel it is addressed at. It neither invents a label nor
      // prints the id, and — the reason this surface is pinned beside the default
      // one — it does not fall through to the words the unaddressed arm uses.
      entity: { kind: "channel", id: `${COMPOSER_SCENARIO.sessionId}-main` },
    },
  });
}

/** The composer addressed at a working run: the new-turn path against a live agent. */
export async function mountComposerProviderBoundRunning(): Promise<MountedFamilySurface> {
  return mountComposerAt({
    throughKind: "run.running",
    focusedPane: { kind: "agent-console", entity: { kind: "agent", id: composerAgentId() } },
  });
}

/** The composer addressed at a run waiting on a person: the steer path. */
export async function mountComposerProviderBoundWaiting(): Promise<MountedFamilySurface> {
  return mountComposerAt({
    throughKind: "run.waiting_for_input",
    focusedPane: { kind: "agent-console", entity: { kind: "agent", id: composerAgentId() } },
  });
}

/**
 * The composer carrying attachments — one settled, one the daemon refused.
 *
 * A SURFACE THE FOUR ADDRESSES ABOVE DO NOT REACH. The attachment strip is absent
 * while a message carries nothing, so every audited composer so far was audited with
 * that whole zone off screen — the strip's own label, each chip's progress bar, and
 * the refusal a chip renders were reachable by no tier at all.
 *
 * BOTH OUTCOMES, because they draw different things: the settled one carries the
 * derived truth and no controls, and the refused one carries a code, a reason, a
 * remedy, and a retry. The fixture ingest plane decides which is which from the
 * name — a payload it can place completes, and one it cannot refuses at completion,
 * where the daemon has the bytes — so the two files below are the two arms and
 * nothing here scripts a reply.
 */
export async function mountComposerWithAttachments(): Promise<MountedFamilySurface> {
  const mounted = await mountComposerProviderBoundRunning();
  await dropFilesOnComposer(mounted.element, [
    new File(["a settled payload"], "notes.md", { type: "text/markdown" }),
    new File(["a payload with no place"], "capture.bin", { type: "application/octet-stream" }),
  ]);
  // ASSERTED RATHER THAN ASSUMED, for `requireNoReadInFlight`'s reason one zone over:
  // a drop that did not land leaves the plain composer, and a tier auditing that is a
  // green case over a surface this mount claims to be about and is not.
  requireStripCarrying(mounted.element, ["notes.md", "capture.bin"]);
  return mounted;
}

/** Throw unless the attachment strip is up and naming every file that was dropped. */
function requireStripCarrying(region: HTMLElement, names: readonly string[]): void {
  const strip = region.querySelector(".meridian-composer-attachments");
  if (strip === null) {
    throw new Error("the drop reached no attachment strip");
  }
  const text = strip.textContent ?? "";
  const missing = names.filter((name) => !text.includes(name));
  if (missing.length > 0) {
    throw new Error(`the strip names none of: ${missing.join(", ")}`);
  }
  // The refused arm is half of what this surface exists to audit, and a fixture that
  // stopped refusing would leave it auditing two settled chips under this name.
  if (strip.querySelector(".meridian-refusal") === null) {
    throw new Error("the strip carries no refusal, so the refused arm is not on screen");
  }
}

/**
 * The composer with the `+` menu open, which is the only way its panel is on screen.
 *
 * The panel is UNMOUNTED while closed rather than hidden, so a tier that audited the
 * composer without opening it audited a document the panel was not in.
 */
export async function mountComposerPlusMenuOpen(): Promise<MountedFamilySurface> {
  const mounted = await mountComposerProviderBoundRunning();
  const trigger = mounted.element.querySelector<HTMLElement>(".meridian-plus-menu__trigger");
  if (trigger === null) {
    throw new Error("the composer rendered no plus-menu trigger to open");
  }
  await act(async () => {
    trigger.click();
  });
  if (mounted.element.querySelector(".meridian-plus-menu__panel") === null) {
    throw new Error("the plus menu did not open");
  }
  return mounted;
}

/**
 * Drop files on the composer the way a person does, and let the ingest settle.
 *
 * `DataTransfer` has no jsdom constructor, so the payload is the array-like shape the
 * drop binding actually consumes — `types` to decide the drag carries files at all,
 * and `files` for its length and `Array.from`. That is exactly as much `FileList` as
 * this path ever sees, and a narrower stand-in chosen to make a mount work would be
 * this file deciding what the binding reads.
 */
async function dropFilesOnComposer(region: HTMLElement, files: readonly File[]): Promise<void> {
  const list: Record<number, File> & { length: number } = { length: files.length };
  files.forEach((file, index) => {
    list[index] = file;
  });
  const drop = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(drop, "dataTransfer", {
    value: { types: ["Files"], files: list as unknown as FileList, dropEffect: "none" },
  });
  await act(async () => {
    region.dispatchEvent(drop);
  });
  // The trio is three round trips through the fixture's own spool, and each leg
  // starts with a file read the browser settles on its own task — so no fixed number
  // of settles is the right number on every host. Waited on the CONDITION instead: a
  // chip still carrying its progress bar is an ingest still in flight, and the drop
  // has landed only when every dropped name is on the strip and no bar remains.
  await act(async () => {
    await crossMacrotaskBoundary();
  });
  await waitFor(
    () => {
      const strip = region.querySelector(".meridian-composer-attachments");
      if (strip === null) {
        throw new Error("the drop has not reached the attachment strip yet");
      }
      const text = strip.textContent ?? "";
      const missing = files.filter((file) => !text.includes(file.name));
      if (missing.length > 0) {
        throw new Error(
          `the strip does not yet name: ${missing.map((file) => file.name).join(", ")}`,
        );
      }
      if (strip.querySelector(".meridian-composer-attachment__progress") !== null) {
        throw new Error("an ingest is still in flight");
      }
    },
    { timeout: ATTACHMENT_INGEST_SETTLE_TIMEOUT_MS },
  );
}

/**
 * How long a dropped file may take to settle through the fixture spool.
 *
 * Bounded by the tier's patience rather than the product's — the three legs run on
 * the browser's own file-read tasks, which a loaded runner stretches — and generous
 * enough that only a spool that stopped answering reaches it.
 */
const ATTACHMENT_INGEST_SETTLE_TIMEOUT_MS = 5_000;

/**
 * A store OPENED at one scenario's own beat range and fed every beat in it.
 *
 * Opening it is not a formality. `useSessionInitialised` is what the runs pane's own
 * `hasRead` reads, and a store nobody opened answers `false` for the window's life —
 * so that pane says "Reading the runs in this session" over a snapshot that was never
 * going to arrive, and both tiers photograph the skeleton. It reached that state with
 * no read in flight and no refusal to render, which is why the mount and not the clock
 * is where it is fixed.
 *
 * The cursor is taken one below the scenario's own lowest sequence rather than from
 * zero: the store admits the batch as the continuation of what it opened at, and a
 * scenario whose log starts at a higher sequence would otherwise be applying beats the
 * store believes it has already seen.
 *
 * THE FOLD IS NOT A PARAMETER, which is the point of it being here at all. It was one,
 * and each caller chose — so the runs pane got the run-lifecycle table and the
 * approvals pane got the approval-flow one, and neither got what a window opens a
 * store with. A caller cannot pick a partition set it is not offered.
 */
function scenarioSeededStore(scenario: ConsoleScenario): SessionStore {
  const store = new SessionStore({
    sessionId: scenario.sessionId,
    projectors: COMPOSED_CONSOLE_PROJECTORS,
  });
  const sequences = scenario.beats.map((beat) => beat.event.sequence);
  store.initialise({
    cursor: Math.min(...sequences) - 1,
    entities: [],
    userJoinLog: [...scenario.userIdsInJoinOrder],
  });
  store.applyBatch(scenario.beats.map((beat) => beat.event as ConsoleSessionEvent));
  return store;
}

/**
 * The runs pane, mounted out of the deck's registry rather than by importing its body.
 *
 * A tier that imported the component would capture a component that happens to sit
 * beside the registration; this captures the body the deck would actually mount, and
 * the family's stylesheet arrives on the barrel edge that owns it — which is what
 * makes the captured pixels the ones a person would see.
 */
export async function mountRunsPane(): Promise<MountedFamilySurface> {
  const bridge = createFixtureBridge({ scenario: RUNS_SCENARIO });
  const RunsPaneBody = await paneBodyComponent("runs", registerRunsPane);
  const container = await mountSurfaceSettled(
    bridge,
    <RunsPaneBody
      kind="runs"
      paneId="pane-runs-surface"
      linkedSourcePaneId={undefined}
      bridge={bridge}
      sessionStore={scenarioSeededStore(RUNS_SCENARIO)}
      frameStore={new FrameStore()}
      uiStateStore={UiStateStore.opening()}
      draftStore={new DraftStore({ maximumDraftCount: MAXIMUM_LIVE_DRAFT_COUNT })}
      focusHue={undefined}
    />,
  );
  const pane = container.querySelector(".meridian-runs");
  if (!(pane instanceof HTMLElement)) {
    throw new Error("the runs pane rendered no .meridian-runs element to capture");
  }
  // By class rather than by accessible name, and the exception is worth stating: the
  // pane's own root is a layout container and the accessible names inside it belong
  // to its three sections, so there is no one labelled element that IS the pane. The
  // sections' names are what the accessibility tier then audits.
  return { element: pane, bridge };
}

/**
 * The approvals pane, over a store opened with the fold a window composes.
 *
 * TWO PARTITIONS, AND THE PANE READS BOTH. The approval-flow fold is what carries the
 * provider-ask framing, and the run-lifecycle fold is what carries the boundary each
 * pending decision was raised under — `ApprovalsPaneBody` joins the two by the `runId`
 * every approval record spells. Registering only the first left the Execution boundary
 * section reading an empty `run` partition and rendering the chip's absent arm, which
 * is the reading reserved for a run that never reached `running`: a picture of the
 * wrong state, minted as a reference and audited as a surface.
 */
export async function mountApprovalsPane(): Promise<MountedFamilySurface> {
  const bridge = createFixtureBridge({ scenario: APPROVALS_SCENARIO });
  const sessionStore = scenarioSeededStore(APPROVALS_SCENARIO);
  const ApprovalsPaneBody = await paneBodyComponent("approvals", registerApprovalsPane);
  const container = await mountSurfaceSettled(
    bridge,
    <ApprovalsPaneBody
      kind="approvals"
      paneId="pane-approvals-surface"
      linkedSourcePaneId={undefined}
      bridge={bridge}
      sessionStore={sessionStore}
      frameStore={new FrameStore()}
      uiStateStore={UiStateStore.opening()}
      draftStore={new DraftStore({ maximumDraftCount: MAXIMUM_LIVE_DRAFT_COUNT })}
      focusHue={undefined}
    />,
  );
  const pane = container.querySelector(".meridian-approvals");
  if (!(pane instanceof HTMLElement)) {
    throw new Error("the approvals pane rendered no .meridian-approvals element to capture");
  }
  // By class rather than by accessible name, for `mountRunsPane`'s reason: the pane
  // root is a layout container and the accessible names inside it belong to its
  // sections.
  return { element: pane, bridge };
}

/**
 * The composer-family pane body the deck holds for a kind, loaded.
 *
 * The resolution — build a family-scoped registry, preload, read the descriptor, throw
 * by name — lives once in `test/console/surfaces/pane-body-resolution.ts`. This family passes its
 * registrar per call rather than registering every family here, so a mount composes the
 * one body it captures.
 */
async function paneBodyComponent(
  kind: PaneKind,
  registerPane: (registry: ConsolePaneRegistry) => void,
): Promise<FunctionComponent<ConsolePaneContext>> {
  return await resolvedPaneBody(kind, registerPane);
}

/**
 * Find the one element a surface renders itself as.
 *
 * Scoped by accessible name rather than by class, because that is what a person
 * using assistive technology navigates by — a surface that lost its accessible name
 * would still match a class selector and would still be captured as if nothing had
 * changed.
 */
function requireRegion(container: HTMLElement, accessibleName: string): HTMLElement {
  const region = container.querySelector(`[aria-label="${accessibleName}"]`);
  if (!(region instanceof HTMLElement)) {
    throw new Error(`nothing in the mounted tree is labelled \`${accessibleName}\``);
  }
  return region;
}
