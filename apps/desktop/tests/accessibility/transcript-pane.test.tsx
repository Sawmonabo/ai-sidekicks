// The accessibility tier for the transcript: a virtualized feed of cards, a facet bar and a
// find field, all hue-tinted per user. Many rules can fail here that fail nowhere else: a muted
// label on a tinted ground, rows mounted and unmounted under the reader, a hover-revealed
// control shipped without a name.
//
// The pane is mounted directly, not through `AppProviders`. The store is opened on the
// scenario's own log because content delivered by scripted beats depends on how far a frozen
// clock was advanced, so the amount of transcript under test would be an accident of the test.
//
// Everything else is the real composition: `SessionStore`, the projection, the
// `@tanstack/react-virtual` instance, the registered row renderer, and the
// `SessionScreenContainer` that gives the scroll container a definite height (a virtualizer
// over a zero-height box reports no rows, and an empty feed would pass).
//
// A loaded transcript and an empty one are different documents, so both run, in both schemes
// for the frame case's contrast reason.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { emulateSystemScheme, renderSettled } from "../helpers/app-harness.js";
import { describeViolations, runTierAxe } from "./axe-run.js";
import { createFixtureBridge } from "@renderer/services/platform/platform-bridge.fixture.js";
import { FixtureBridgeProvider } from "@test/helpers/app-frame-fixtures.js";
import type { Scenario } from "../../fixtures/scenario.js";
import { EMPTY_SESSION_SCENARIO } from "../../fixtures/scenarios/empty-session.js";
import { TRANSCRIPT_STATES_SCENARIO } from "../../fixtures/scenarios/transcript-states.js";
import { installMeridianTokens } from "@renderer/app/token-installation.js";
// Imported deeply, not through the feature's `index.ts`: widening the public entry for one test
// would be wrong.
import { registerTranscriptRows } from "@renderer/features/transcript/contributions/transcript-rows.js";
import { TranscriptPane } from "@renderer/features/transcript/TranscriptPane.js";
import { transcriptPaneContext } from "@renderer/features/transcript/TranscriptPane.test-support.js";
import { SessionStore } from "@renderer/store/session/session-store.js";
import { COLOR_SCHEMES } from "@renderer/styles/tokens.js";
import { SessionScreenContainer } from "@renderer/features/transcript/SessionScreenContainer.js";

/**
 * The cursor a scenario's log is applied on top of. Zero rather than `-1`, because
 * `composeScriptBeats` numbers beats from one: a store rebased at `-1` would record a gap
 * before the first beat and mark itself degraded.
 */
const SCENARIO_BASE_CURSOR = 0;

/**
 * A real store holding the whole of one scenario's log, so the projection, the run group fold
 * and the superseded index run over real state. The quiet scenario scripts no beats, which is
 * how the empty case reaches a state a scripted stream never produces.
 */
function openStoreOnScenario(scenario: Scenario): SessionStore {
  const sessionStore = new SessionStore({ sessionId: scenario.sessionId });
  sessionStore.initialize({
    cursor: SCENARIO_BASE_CURSOR,
    entities: [],
  });
  if (scenario.beats.length > 0) {
    sessionStore.applyBatch(scenario.beats.map((beat) => beat.event));
  }
  return sessionStore;
}

/**
 * Mount one scenario's transcript the way a window mounts it. `SessionScreenContainer` is
 * the production wrapper that carries the full-height grid down to the scroll container.
 */
async function mountTranscript(scenario: Scenario): Promise<HTMLElement> {
  const sessionStore = openStoreOnScenario(scenario);
  const { container } = await renderSettled(
    <FixtureBridgeProvider fixture={createFixtureBridge({ scenario })}>
      <SessionScreenContainer>
        <TranscriptPane context={transcriptPaneContext(sessionStore, scenario.sessionId)} />
      </SessionScreenContainer>
    </FixtureBridgeProvider>,
  );
  return container;
}

beforeEach(() => {
  installMeridianTokens(document);
  // The row renderer, registered the way the console registers it; the pane cannot render
  // rows without one.
  registerTranscriptRows();
});

afterEach(async () => {
  await emulateSystemScheme("light");
});

describe("accessibility — the transcript", () => {
  for (const scheme of COLOR_SCHEMES) {
    it(`has no axe violation over a loaded transcript in the ${scheme} scheme`, async () => {
      // Through the system preference, as in the frame case: the scheme attribute has an owner,
      // and writing it would measure both cases against one palette.
      await emulateSystemScheme(scheme);
      const container = await mountTranscript(TRANSCRIPT_STATES_SCENARIO);

      // The positive control for the case: axe over a feed that mounted no rows returns the same
      // empty list as one that mounted them all, so without this the clean result could hold
      // over a transcript that drew nothing.
      expect(
        container.querySelectorAll(".meridian-transcript-viewport__row").length,
        "the transcript mounted no rows, so a clean axe result says nothing about a card",
      ).toBeGreaterThan(0);

      expect(describeViolations(await runTierAxe(container))).toStrictEqual([]);
    });

    it(`has no axe violation over the transcript's empty state in the ${scheme} scheme`, async () => {
      await emulateSystemScheme(scheme);
      const container = await mountTranscript(EMPTY_SESSION_SCENARIO);

      // The same control from the other side: the pane must actually have reached the empty
      // state, which a scenario that grew a beat would silently stop doing.
      expect(container.textContent).toContain("No messages yet. Say what you are after.");
      expect(container.querySelectorAll(".meridian-transcript-viewport__row")).toHaveLength(0);

      expect(describeViolations(await runTierAxe(container))).toStrictEqual([]);
    });
  }
});
