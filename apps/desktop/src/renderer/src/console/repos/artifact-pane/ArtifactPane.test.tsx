// The artifact pane's rendered surface: its chrome, the absence it draws before a read,
// the two disclosures `ArtifactPane.tsx` puts at its foot, and the instant a row's age
// is measured against.
//
// WHAT THE PANE DOES IS NEXT DOOR. `ArtifactPane.acts.test.tsx` drives the row acts —
// the manifest read and the delete — and `ArtifactPane.reader-seam.test.tsx` drives how
// the pane's reader is held: the clock it runs on and the subject-scoped seam that
// re-mints it. The payload fetch is further along still, in
// `ArtifactPayloadSection.test.tsx`, the section being its own component now.
//
// The case that matters most in the first block is the last one: `empty` here would be
// the console stating that the session has no artifacts, a fact no read established.
// The bounds block is about the disclosure whose whole value is that it names WHICH
// list it is showing — the shipped default and the deployment's effective list are
// different claims and an operator override replaces one with the other wholesale.

import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fixtureBridgeWithGrowth } from "../../bridge/fixture-bridge.test-support.js";
import { REPOS_SCENARIO } from "../../bridge/scenarios/repos.js";
import { ManualClock } from "../../core/index.js";
import { ATTACHMENT_ALLOWLIST_DEFAULT } from "../attachments/attachment-policy.js";
import { SessionStore } from "../../store/index.js";
import { scenarioManualClock } from "../scenario-clock.test-support.js";
import {
  type GrowthPortAnswer,
  LISTED_ONE_ROW,
  SESSION_ID,
  artifactBridgeAnswering,
  readThrough,
  settleAct,
} from "./artifact-pane.test-support.js";
import {
  ARTIFACT_ENTITY,
  OTHER_ARTIFACT_ENTITY,
  contextFor,
  paneTree,
  renderPane,
} from "./artifact-pane-mount.test-support.js";
import { paneSubjectCrumb, paneTrailCrumbs } from "../pane-chrome.test-support.js";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("artifact pane — the chrome it wears", () => {
  it("is named by the whole trail, not by the word Artifact", () => {
    // The claim the binding exists for. A body drawing its own header named every
    // artifact pane in a deck "Artifact"; the chrome names it by where it is, so two
    // panes of one kind are told apart by the subjects they are views of. The name
    // ENDS in the kind and is longer than it, which a pre-binding pane fails on both
    // counts.
    const { getByRole } = renderPane(
      contextFor(ARTIFACT_ENTITY, { sessionId: "session-artifact-chrome" }),
    );
    const region = getByRole("region", { name: /Artifact$/u });
    const accessibleName = region.getAttribute("aria-labelledby");
    expect(accessibleName).not.toBeNull();
    expect(region.textContent).toContain(ARTIFACT_ENTITY.id);
    expect(() => getByRole("region", { name: "Artifact" })).toThrow();
  });

  it("puts the session and the subject in the trail, in that order", () => {
    const { container } = renderPane(
      contextFor(ARTIFACT_ENTITY, { sessionId: "session-artifact-chrome" }),
    );
    expect(paneTrailCrumbs(container)).toStrictEqual([
      "session-artifact-chrome",
      ARTIFACT_ENTITY.id,
      "Artifact",
    ]);
  });

  it("negative control: the subject crumb is read from the address, not fixed", () => {
    // Without this, the cases above would pass over a chrome that rendered a constant.
    // An artifact address always carries its artifact — the arm has no shape in which
    // it is absent — so the honest control is a second subject rather than none.
    const { container } = renderPane(contextFor(OTHER_ARTIFACT_ENTITY));
    expect(paneSubjectCrumb(container)).toBe(OTHER_ARTIFACT_ENTITY.id);
  });

  it("offers one re-read control, keyboard-reachable and named", () => {
    const { getByRole } = renderPane(contextFor(ARTIFACT_ENTITY));
    expect(getByRole("button", { name: "Read again" })).toBeDefined();
  });

  it("names the reply members a payload fetch is waiting on", () => {
    // The read serves a manifest. Saying so at the top of the body is what keeps a
    // participant from waiting for a download that no registered reply carries.
    const { container } = renderPane(contextFor(ARTIFACT_ENTITY));
    const note = container.querySelector(".meridian-artifact-pane__read-scope-note");
    expect(note?.textContent).toContain("payloadHandle");
    expect(note?.textContent).toContain("payload");
  });
});

describe("artifact pane — the absence it renders", () => {
  it("says the question was not put, on a surface", () => {
    const { container } = renderPane(contextFor(ARTIFACT_ENTITY));
    const nothing = container.querySelector(".meridian-nothing");
    expect(nothing?.classList.contains("meridian-nothing--not-checked")).toBe(true);
    expect(nothing?.classList.contains("meridian-nothing--block")).toBe(true);
  });

  it("negative control: it is not the empty shape", () => {
    // `empty` would assert that the session's artifact read came back with none.
    // Nothing has been read, and the two absences render as different shapes.
    const { container } = renderPane(contextFor(ARTIFACT_ENTITY));
    expect(container.querySelector(".meridian-nothing--empty")).toBeNull();
  });
});

describe("artifact pane — the ingest bounds disclosure", () => {
  it("names the shipped default as the default when the effective list is unread", () => {
    const { container } = renderPane(contextFor(ARTIFACT_ENTITY));
    const source = container.querySelector(".meridian-ingest-bounds__source");
    expect(source?.textContent).toContain("shipped default");
  });

  it("lists the admitted types and leaves out the scriptable image", () => {
    const { container } = renderPane(contextFor(ARTIFACT_ENTITY));
    const types = container.querySelector(".meridian-ingest-bounds__types");
    expect(types?.textContent).toContain("application/pdf");
    expect(types?.textContent).not.toContain("image/svg+xml");
    expect(container.querySelectorAll(".meridian-ingest-bounds__types li")).toHaveLength(
      ATTACHMENT_ALLOWLIST_DEFAULT.length,
    );
  });

  it("names all four bounds a participant can hit", () => {
    const { container } = renderPane(contextFor(ARTIFACT_ENTITY));
    const caps = container.querySelector(".meridian-ingest-bounds__caps");
    expect(caps?.textContent).toContain("Per attachment");
    expect(caps?.textContent).toContain("Per carrier");
    expect(caps?.textContent).toContain("Per chunk");
    expect(caps?.textContent).toContain("Per upload");
  });

  it("renders a refusal that carries no served discriminant, and reads the list beside it", async () => {
    // THE SHAPE THAT TOOK THE WHOLE PANE DOWN. `core`'s `refuse(...)` is the console's
    // three refusal fields and no `status` — the value `growthUnavailable` spreads to
    // build its own — and a reader that asked only whether `status` was
    // `"unavailable"` read it as served, dereferenced it for `contentTypes`, and
    // published a `read-threw` refusal whose sentence was a `TypeError`. So both
    // halves are asserted: the disclosure shows the refusal on its designed
    // shipped-default arm, and the list beside it still read.
    const { paneClock, container } = renderPane(
      contextFor(ARTIFACT_ENTITY, {
        bridge: fixtureBridgeWithGrowth(REPOS_SCENARIO, {
          artifactList: async () => LISTED_ONE_ROW,
          // THE CAST IS ON THE ANSWER AND NOT ON THE BRIDGE. This shape is deliberately
          // outside the port's own union — that is the whole case — so the arm serving
          // it says so in one place, while every other namespace stays the fixture's.
          artifactAllowlistRead: async () =>
            ({
              code: "wire-unregistered",
              detail: "Not checked — the artifact CRUD method strings are not registered yet.",
              origin: "growth-port",
            }) as unknown as GrowthPortAnswer<"artifactAllowlistRead">,
        }),
        sessionId: SESSION_ID,
      }),
    );
    await readThrough(paneClock);
    expect(container.querySelector(".meridian-ingest-bounds__source")?.textContent).toContain(
      "shipped default",
    );
    expect(container.querySelector(".meridian-ingest-bounds__refusal")?.textContent).toContain(
      "wire-unregistered",
    );
    expect(container.textContent).not.toContain("read-threw");
    expect(container.textContent).not.toContain("contentTypes");
  });

  it("negative control: the pane offers no visibility toggle", () => {
    // The wire carries an `artifact.visibility_updated` event and
    // `bridge/growth-port.ts` registers no operation that could produce one. A
    // control that could only fail is worse than a control that is not there, and a
    // port entry is not this family's to add.
    const { queryByRole } = renderPane(contextFor(ARTIFACT_ENTITY));
    expect(queryByRole("button", { name: "Share with the session" })).toBeNull();
    expect(queryByRole("button", { name: "Make local-only" })).toBeNull();
  });
});

describe("artifact pane — the instant a row's age is read against", () => {
  it("renders an age from the reader's clock, so a frozen scenario renders one text", async () => {
    // The defect: the pane read `Date.now()` in its render body. `test/console/surfaces/repos.tsx`
    // recorded the consequence in its own words — the pane built a clock behind the
    // binding and no surface could hand it one — so a screenshot subject that listed a
    // row pinned text derived from real wall-clock time against a fixture `createdAt`,
    // and the same subject rendered differently the next month.
    //
    // The reading now carries the instant the READER took, off the window's own clock.
    // Under the fixture that clock is frozen at the scenario's declared start, so the
    // row's age is a fixed distance between two fixed stamps — the scenario's
    // 2026-01-01 against `SERVED_SUMMARY`'s September `createdAt` — and the row says
    // the artifact is most of a year in the FUTURE, which no wall clock can produce.
    const { paneClock, container } = renderPane(
      contextFor(ARTIFACT_ENTITY, {
        bridge: artifactBridgeAnswering({ listAnswer: LISTED_ONE_ROW }),
        sessionId: SESSION_ID,
      }),
    );
    await readThrough(paneClock);
    await settleAct();

    const age = container.querySelector(".meridian-artifact-row")?.textContent ?? "";
    expect(age).toContain("in 244 days");
  });

  it("holds that age still while the pane re-renders under it", async () => {
    // The other half of the rule: an age moves when the READ moves and on no other
    // occasion. A body reading the wall clock moves it on any unrelated re-render —
    // and one that advanced on a timer would be the interval poll the budget forbids,
    // wearing a clock face.
    const sessionStore = new SessionStore({ sessionId: SESSION_ID });
    const bridge = artifactBridgeAnswering({ listAnswer: LISTED_ONE_ROW });
    const clock = scenarioManualClock(bridge);
    const announcerClock = new ManualClock();
    const { container, rerender } = render(
      paneTree(contextFor(ARTIFACT_ENTITY, { bridge, sessionStore }), announcerClock),
    );
    await readThrough(clock);
    await settleAct();
    const before = container.querySelector(".meridian-artifact-row")?.textContent ?? "";

    // Time really passes, and the pane really re-renders — with no read in between.
    clock.advance(3_600_000);
    rerender(paneTree(contextFor(ARTIFACT_ENTITY, { bridge, sessionStore }), announcerClock));
    await settleAct();

    expect(container.querySelector(".meridian-artifact-row")?.textContent).toBe(before);
    expect(before).not.toBe("");
  });
});
