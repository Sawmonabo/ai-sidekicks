// Tier: end-to-end. Its spec files are named for the incident they reproduce
// rather than for the module they touch.
//
// Every other console tier renders the console into something that is not the
// application: happy-dom for the unit tier, a Chromium page for the three browser-mode
// tiers. None of them can catch a defect that exists only in the shipped shell, and
// this tier runs the code path a person installing the application would run.
//
// ONE ASSERTION LIBRARY, DELIBERATELY. Playwright ships its own auto-retrying `expect`
// and it is not used here: mixing two `expect`s makes which timeout applies to a line
// a question a reader answers from the import list, and Playwright's web-assertion
// timeouts are read from a test context this runner does not provide. Waiting is
// explicit (`locator.waitFor`, `expect.poll`) and asserting is Vitest's.
//
// THE INCIDENT: the shell opened a window and the console was not in it.
//
// Two shapes of the same report, and the seams they land on are different. The window
// is served from a scheme that was never registered as standard, so the document has
// no origin and the renderer boots into a storage error; or the bundle loads, the
// frame mounts, and the composition is empty — no rail, no mounted surface, and an
// unowned pane kind rendering as a hole rather than as a composed absence.
//

import { describe, expect, it } from "vitest";

import { RENDERER_ORIGIN } from "../../../src/main/renderer-scheme.js";
import { FIRST_RUN_SCENARIO } from "../../../src/renderer/src/console/bridge/scenario/first-run.js";
import { PANE_HARNESS_LABEL } from "../../../src/renderer/src/console/frame/pane-harness/PaneHarnessFrame.js";
import { withLaunchedConsole } from "../electron-harness.js";
import { fixtureBundleExists } from "../fixture-bundle.js";
import { IN_WINDOW_STEP_TIMEOUT_MS } from "../launch-body.js";

const bundleIsBuilt = fixtureBundleExists();

describe.skipIf(!bundleIsBuilt)("end-to-end — console came up blank", () => {
  it("serves the window from the privileged renderer scheme", async () => {
    await withLaunchedConsole({}, async (consoleApplication) => {
      // The origin is the persistence partition key: a scheme registered without
      // `standard: true` has no origin at all, and an origin-less document gets
      // neither IndexedDB nor `localStorage` — so the scheme-persistence test
      // below would fail with a storage error that says nothing about the cause.
      // Asserted first, and against the main process's own constant rather than
      // against a repeated string, so a scheme or host rename breaks this at
      // compile time instead of leaving it comparing two stale literals.
      const origin = await consoleApplication.window.evaluate(() => window.location.origin);
      expect(origin).toBe(RENDERER_ORIGIN);
    });
  });

  it("boots the frame with its rail, a mounted surface, and a composed absence", async () => {
    // The scenario is NAMED rather than defaulted, and that is this case's premise
    // rather than a detail of it: every claim below is about the first-run
    // composition — an empty directory, a readable session, an unowned pane kind —
    // and a window that names no scenario now plays the demo and opens into it, which
    // is the first-launch rule doing exactly what it was built to do. Naming the
    // scenario is also what stands that rule down, on the same principle the rule
    // applies to an explicit hash: a launch that said what it wanted is not overridden.
    await withLaunchedConsole({ scenarioId: FIRST_RUN_SCENARIO.id }, async (consoleApplication) => {
      const consoleWindow = consoleApplication.window;

      // The rail exists and carries the destinations the frame declares. Read as
      // a count rather than as specific labels: which destinations exist is the
      // route table's business and it is asserted there, while "the rail rendered
      // at all" is this tier's.
      const railButtonCount = await consoleWindow.locator(".meridian-rail__button").count();
      expect(railButtonCount).toBeGreaterThan(0);

      // The sessions destination has an owner — the frame's own all-sessions
      // surface, which creates nothing on mount and builds the absorbed
      // session-bootstrap probe only when a participant presses "Start a
      // session". The claim is that the OWNER rendered and the frame's
      // reserved-slot arm did not fire: the owner's section is present and the
      // frame's composed absence wrapper is not.
      await consoleWindow.locator(".meridian-frame").waitFor({
        state: "visible",
        timeout: consoleApplication.bodyAllowance.boundedMs(IN_WINDOW_STEP_TIMEOUT_MS),
      });
      await consoleWindow.locator(".meridian-sessions").waitFor({
        state: "visible",
        timeout: consoleApplication.bodyAllowance.boundedMs(IN_WINDOW_STEP_TIMEOUT_MS),
      });
      expect(await consoleWindow.locator(".meridian-surface-absence").count()).toBe(0);

      // And the directory read has a PRODUCER, which is what this destination
      // could not have in any build before it: the only session set the renderer
      // could name was the set this window happened to have opened, and a fresh
      // window had opened none.
      //
      // A launched shell plays the first-run scenario — a fresh install with no
      // sessions on the node — so the answer here is a served-and-empty directory,
      // and the surface renders the EMPTY kind of nothing: "no sessions yet", a
      // stated fact with a next action. The claim is that kind SPECIFICALLY, which
      // is what separates it from the two absences either side of it: a refused
      // directory renders `not-checked` ("the console never asked", which is what a
      // build with no producer shows) and a read still in flight renders
      // `not-loaded`. Waited for rather than counted immediately, because the read
      // is asynchronous and a bare count would race it into the `not-loaded` arm.
      //
      // Scoped to the list region rather than to the whole surface: the aside
      // beside it puts two OTHER reads on screen — the invitations shelf and the
      // attention panel — and each renders its own honest absence, so an unscoped
      // exclusion would be asserting that those reads had answered rather than
      // that this one had.
      await consoleWindow.locator(".meridian-sessions__list .meridian-nothing--empty").waitFor({
        state: "visible",
        timeout: consoleApplication.bodyAllowance.boundedMs(IN_WINDOW_STEP_TIMEOUT_MS),
      });
      expect(
        await consoleWindow
          .locator(".meridian-sessions__list .meridian-nothing--not-checked")
          .count(),
      ).toBe(0);
      expect(
        await consoleWindow
          .locator(".meridian-sessions__list .meridian-nothing--not-loaded")
          .count(),
      ).toBe(0);

      // The COMPOSED absence, in a real window, which is the half of the pair that
      // makes the other half mean something: without it, "no absence wrapper on
      // sessions" would also pass over a frame that had stopped rendering that arm
      // altogether. And it must be the composed one, not a bare line, because a bare
      // line at the top-left of a real window is what a half-painted page looks like.
      //
      // IT IS THE HARNESS'S ADMISSION REFUSAL, AND NO LONGER ITS RESERVED ARM. Every
      // previous revision of this probe pointed at a destination nobody owned — off
      // `#/settings` when the collaboration family took it, off `#/workflows` when the
      // workflows family took that, off `#/window/timeline/…` once the ledger claimed
      // the last unowned SURFACE slot, and then one layer down at a pane kind the deck
      // declared and no family rendered. That last address is gone too: `registeredPaneKinds()`
      // now answers with all eleven of `PANE_KINDS`, so no address anywhere in a built
      // console reaches a reserved arm, and each earlier revision's own instruction —
      // re-point it, do not delete it — ends here, at the point it named: there is no
      // slot left to be told to reserve.
      //
      // What replaces it is an absence a family can never claim away, because it does
      // not fire on a pane kind at all: `PaneHarnessSurface` holds the address segment
      // to `parseConsolePaneAddress`, the console's one admission point for an address
      // that arrived untyped, and a segment that names no kind is refused there. That
      // is also the STRONGER end-to-end subject of the two — a reserved arm is a state
      // a shipped build can only reach through its own composition mistake, while a
      // mistyped hash is a thing a person actually does. The reserved arms themselves
      // stay pinned where they can be driven directly, with a registry that holds no
      // descriptor: `PaneHarnessSurface.test.tsx` for this one and `RouteSurface.test.tsx`
      // for the slot layer above it. Point this back at a reserved arm the day a kind is
      // declared in `PANE_KINDS` ahead of the family that renders it.
      //
      // BOTH address segments are required by that route's grammar, and the session
      // is the scenario's own: the first-run DIRECTORY is empty, which is what the
      // assertion above is about, while the session it holds is readable, which is
      // what gets the store open and the route as far as the surface.
      await consoleWindow.evaluate((sessionId: string) => {
        window.location.hash = `#/pane-harness/not-a-pane-kind/${sessionId}`;
      }, FIRST_RUN_SCENARIO.sessionId);
      // `--block` is the composed placement, and asserting it is the other half of
      // "not a bare line": the surface layer proved that with `SurfaceAbsence`, and
      // this arm renders its `Nothing` inside the harness region instead, where the
      // placement modifier is what carries the same claim.
      await consoleWindow
        .locator(
          `section[aria-label="${PANE_HARNESS_LABEL}"] .meridian-nothing--block.meridian-nothing--error`,
        )
        .waitFor({
          state: "visible",
          timeout: consoleApplication.bodyAllowance.boundedMs(IN_WINDOW_STEP_TIMEOUT_MS),
        });
    });
  });
});
