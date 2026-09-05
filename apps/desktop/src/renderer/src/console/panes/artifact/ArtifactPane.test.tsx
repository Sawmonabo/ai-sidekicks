// The artifact pane: its chrome, the absence it renders before a read, the two
// disclosures `ArtifactPane.tsx` puts at its foot, and what its row acts actually do.
//
// THE PAYLOAD FETCH IS NEXT DOOR, in `ArtifactPayloadSection.test.tsx`: the section is
// its own component now, and the arms it draws are its suite's subject rather than
// this one's.
//
// The case that matters most in the first block is the last one: `empty` here would be
// the console stating that the session has no artifacts, a fact no read established.
// The bounds block is about the disclosure whose whole value is that it names WHICH
// list it is showing — the shipped default and the deployment's effective list are
// different claims and an operator override replaces one with the other wholesale.
//
// The acts block is the one that fails on a pane that discards what it is served. The
// read used to be called "Fetch payload" and used to throw its answer away, so pressing
// it changed nothing at all — no row, no sentence, no refusal. Both halves are checked
// here: the control is named for the manifest the read serves, and a served answer
// reaches the row.

import { fireEvent, render, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ConsoleBridge } from "../../bridge/index.js";
import { ManualClock } from "../../core/index.js";
import { LiveAnnouncerProvider } from "../../primitives/index.js";
import { ARTIFACT_PAYLOAD_DISPOSITION_COPY } from "../../repos/artifacts/artifact-model.js";
import { ATTACHMENT_ALLOWLIST_DEFAULT } from "../../repos/attachments/attachment-policy.js";
import { SessionStore } from "../../store/index.js";
import { ArtifactPane } from "./ArtifactPane.js";
import {
  ARTIFACT_ENTITY,
  SERVED_DELETE,
  LISTED_ONE_ROW,
  OTHER_ARTIFACT_ENTITY,
  SESSION_ID,
  artifactBridgeAnswering,
  confirmDelete,
  contextFor,
  paneTree,
  readAnswering,
  readThrough,
  renderPane,
  renderPaneStrictly,
  settleAct,
} from "./artifact-pane.test-support.js";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("artifact pane — chrome", () => {
  it("names itself as a region", () => {
    const { getByRole } = renderPane(contextFor(ARTIFACT_ENTITY));
    expect(getByRole("region", { name: "Artifact" })).toBeDefined();
  });

  it("renders the subject verbatim, with the full string recoverable", () => {
    const { container } = renderPane(contextFor(ARTIFACT_ENTITY));
    const subject = container.querySelector(".meridian-repos-pane__subject");
    expect(subject?.textContent).toBe(ARTIFACT_ENTITY.id);
    expect(subject?.getAttribute("title")).toBe(ARTIFACT_ENTITY.id);
  });

  it("negative control: the subject is read from the address, not fixed", () => {
    // Without this, the case above would pass over a chrome that rendered a constant.
    // An artifact address always carries its artifact — the arm has no shape in which
    // it is absent — so the honest control is a second subject rather than none.
    const { container } = renderPane(contextFor(OTHER_ARTIFACT_ENTITY));
    const subject = container.querySelector(".meridian-repos-pane__subject");
    expect(subject?.textContent).toBe(OTHER_ARTIFACT_ENTITY.id);
    expect(subject?.getAttribute("title")).toBe(OTHER_ARTIFACT_ENTITY.id);
  });

  it("offers one re-read control, keyboard-reachable and named", () => {
    const { getByRole } = renderPane(contextFor(ARTIFACT_ENTITY));
    expect(getByRole("button", { name: "Read again" })).toBeDefined();
  });

  it("names the reply members a payload fetch is waiting on", () => {
    // The read serves a manifest. Saying so beside the control is what keeps a
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
    const { container } = renderPane(
      contextFor(ARTIFACT_ENTITY, {
        bridge: {
          growth: {
            artifactList: async () => LISTED_ONE_ROW,
            artifactAllowlistRead: async () => ({
              code: "wire-unregistered",
              detail: "Not checked — the artifact CRUD method strings are not registered yet.",
              origin: "growth-port",
            }),
          },
        } as unknown as ConsoleBridge,
        sessionId: SESSION_ID,
      }),
    );
    await readThrough();
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

describe("artifact pane — reading one row's manifest", () => {
  it("offers the row's manifest re-read beside the pane's own payload fetch", async () => {
    // Two acts over one method, told apart by `includePayload`. The row's control is
    // named for what its read serves; the pane's is named for the bytes it asks for.
    const { getByRole } = renderPane(
      contextFor(ARTIFACT_ENTITY, {
        bridge: artifactBridgeAnswering({ listAnswer: LISTED_ONE_ROW }),
        sessionId: SESSION_ID,
      }),
    );
    await readThrough();
    expect(getByRole("button", { name: "Read manifest" })).toBeDefined();
    expect(getByRole("button", { name: "Fetch payload" })).toBeDefined();
  });

  it("puts the served manifest on the row it was read for", async () => {
    // The case a discarded result fails: the read answers with a state the list did
    // not carry, and the row has to move to it.
    const { container, getByRole } = renderPane(
      contextFor(ARTIFACT_ENTITY, {
        bridge: artifactBridgeAnswering({
          listAnswer: LISTED_ONE_ROW,
          readAnswer: readAnswering("superseded"),
        }),
        sessionId: SESSION_ID,
      }),
    );
    await readThrough();
    const row = container.querySelector(".meridian-artifact-row") as HTMLElement;
    expect(within(row).getByText("published")).toBeDefined();

    fireEvent.click(getByRole("button", { name: "Read manifest" }));
    await settleAct();

    const settled = container.querySelector(".meridian-artifact-row") as HTMLElement;
    expect(within(settled).getByText("superseded")).toBeDefined();
    expect(within(settled).queryByText("published")).toBeNull();
  });

  it("says once that the manifest was re-read", async () => {
    const { container, getByRole } = renderPane(
      contextFor(ARTIFACT_ENTITY, {
        bridge: artifactBridgeAnswering({
          listAnswer: LISTED_ONE_ROW,
          readAnswer: readAnswering("superseded"),
        }),
        sessionId: SESSION_ID,
      }),
    );
    await readThrough();
    // Nothing settled yet, so nothing has been said.
    expect(container.querySelector('[role="status"]')?.textContent).toBe("");

    fireEvent.click(getByRole("button", { name: "Read manifest" }));
    await settleAct();

    expect(container.querySelector('[role="status"]')?.textContent).toContain("Manifest re-read");
  });

  it("renders the refusal beside the control and leaves the row where it was", async () => {
    const { container, getByRole } = renderPane(
      contextFor(ARTIFACT_ENTITY, {
        bridge: artifactBridgeAnswering({ listAnswer: LISTED_ONE_ROW }),
        sessionId: SESSION_ID,
      }),
    );
    await readThrough();
    fireEvent.click(getByRole("button", { name: "Read manifest" }));
    await settleAct();

    const row = container.querySelector(".meridian-artifact-row") as HTMLElement;
    expect(row.textContent).toContain("wire-unregistered");
    expect(within(row).getByText("published")).toBeDefined();
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      "the artifact CRUD method strings are not registered yet",
    );
  });

  it("negative control: a re-render on its own announces nothing", async () => {
    // The sentence belongs to the act's settlement. A pane that announced from a
    // render body would speak again on every unrelated transition. The same bridge
    // and session are handed back, so the reader is the one that already read and
    // this is a re-render rather than a remount.
    const bridge = artifactBridgeAnswering({ listAnswer: LISTED_ONE_ROW });
    const context = contextFor(ARTIFACT_ENTITY, { bridge, sessionId: SESSION_ID });
    const { container, getByRole, rerender } = renderPane(context);
    await readThrough();
    rerender(
      <LiveAnnouncerProvider clock={new ManualClock()}>
        <ArtifactPane context={context} />
      </LiveAnnouncerProvider>,
    );
    await settleAct();
    expect(container.querySelector('[role="status"]')?.textContent).toBe("");
    expect(getByRole("button", { name: "Read manifest" })).toBeDefined();
  });
});

describe("artifact pane — deleting one row", () => {
  it("takes the row off the list and reads the list again", async () => {
    // The case a discarded reply fails: a served delete used to leave the manifest on
    // screen, so a participant could keep acting on something the daemon destroyed.
    const artifactList = vi
      .fn<() => Promise<unknown>>()
      .mockResolvedValueOnce(LISTED_ONE_ROW)
      .mockResolvedValue({ status: "served", value: [] });
    const { container, getByRole } = renderPane(
      contextFor(ARTIFACT_ENTITY, {
        bridge: artifactBridgeAnswering({
          listAnswer: LISTED_ONE_ROW,
          artifactList,
          deleteAnswer: SERVED_DELETE,
        }),
        sessionId: SESSION_ID,
      }),
    );
    await readThrough();
    expect(container.querySelectorAll(".meridian-artifact-row")).toHaveLength(1);

    confirmDelete(getByRole);
    await settleAct();
    expect(container.querySelectorAll(".meridian-artifact-row")).toHaveLength(0);

    // One re-read, coalesced through the same scheduler the pane's own control uses.
    await readThrough();
    expect(artifactList).toHaveBeenCalledTimes(2);
  });

  it("says what the delete reported, in the daemon's own two facts", async () => {
    const { container, getByRole } = renderPane(
      contextFor(ARTIFACT_ENTITY, {
        bridge: artifactBridgeAnswering({
          listAnswer: LISTED_ONE_ROW,
          deleteAnswer: SERVED_DELETE,
        }),
        sessionId: SESSION_ID,
      }),
    );
    await readThrough();
    confirmDelete(getByRole);
    await settleAct();

    const spoken = container.textContent ?? "";
    expect(spoken).toContain("Artifact deleted");
    // Both members of the receipt, and neither the old sentence's claim that the
    // reply carried nothing.
    expect(spoken).toContain(ARTIFACT_PAYLOAD_DISPOSITION_COPY.retained_by_references);
    expect(spoken).toContain("Re-publishing this artifact is now permanently impossible.");
    expect(spoken).not.toContain("no payload disposition");
  });

  it("draws the receipt on the panel as well as announcing it", async () => {
    const { container, getByRole } = renderPane(
      contextFor(ARTIFACT_ENTITY, {
        bridge: artifactBridgeAnswering({
          listAnswer: LISTED_ONE_ROW,
          deleteAnswer: SERVED_DELETE,
        }),
        sessionId: SESSION_ID,
      }),
    );
    await readThrough();
    confirmDelete(getByRole);
    await settleAct();

    const receipt = container.querySelector(".meridian-artifacts__receipt");
    expect(receipt?.textContent).toContain(
      ARTIFACT_PAYLOAD_DISPOSITION_COPY.retained_by_references,
    );
  });

  it("negative control: the receipt is cleared by the list read that follows it", async () => {
    // A consequence left standing over a re-read would read as a fact about the list
    // now on screen rather than about the row that is gone.
    const artifactList = vi.fn<() => Promise<unknown>>().mockResolvedValue(LISTED_ONE_ROW);
    const { container, getByRole } = renderPane(
      contextFor(ARTIFACT_ENTITY, {
        bridge: artifactBridgeAnswering({ artifactList, deleteAnswer: SERVED_DELETE }),
        sessionId: SESSION_ID,
      }),
    );
    await readThrough();
    confirmDelete(getByRole);
    await settleAct();
    expect(container.querySelector(".meridian-artifacts__receipt")).not.toBeNull();

    await readThrough();
    expect(container.querySelector(".meridian-artifacts__receipt")).toBeNull();
  });
});

describe("artifact pane — the reader runs on the window's clock, never one of its own", () => {
  it("reads when the scenario clock reaches the window, not when the host's does", async () => {
    // The defect: `ArtifactPaneReader` defaulted to a `RealClock`, so a pane composed
    // under the fixture coalesced its reads against wall time while the scenario
    // advanced on frozen time. On that code the host-timer advance below lists the row
    // and this case fails on its first assertion.
    const clock = new ManualClock();
    const { container } = renderPane(
      contextFor(ARTIFACT_ENTITY, {
        bridge: artifactBridgeAnswering({ listAnswer: LISTED_ONE_ROW, clock }),
        sessionId: SESSION_ID,
      }),
    );

    await readThrough();
    expect(container.querySelector(".meridian-artifact-row")).toBeNull();

    await readThrough(clock);
    await settleAct();
    expect(container.querySelector(".meridian-artifact-row")).not.toBeNull();
  });

  it("negative control: a bridge with no scenario clock still reads on the host's", async () => {
    // `consoleClockFor` mints a `RealClock` where no engine is running, which is what
    // every other case here relies on — so the case above is about which clock the
    // reader was handed rather than about the pane having stopped reading.
    const { container } = renderPane(
      contextFor(ARTIFACT_ENTITY, {
        bridge: artifactBridgeAnswering({ listAnswer: LISTED_ONE_ROW }),
        sessionId: SESSION_ID,
      }),
    );

    await readThrough();
    expect(container.querySelector(".meridian-artifact-row")).not.toBeNull();
  });
});

describe("artifact pane — the reader is held by the subject-scoped seam", () => {
  it("comes back from the disposal-then-replay React's double-mount performs", async () => {
    // The defect this arm closes. A reader constructed in `useMemo` and disposed by
    // the effect's cleanup meets `StrictMode` like this: setup starts it, cleanup
    // DISPOSES it, and the replayed setup calls `start()` on the corpse, which returns
    // at once because a disposed reader reads nothing ever again. The pane then sits
    // on its not-read absence for the life of the mount, with no refusal and no
    // sentence — there is nothing on screen that could say so. On that code this case
    // fails on the row assertion below.
    const clock = new ManualClock();
    const { container } = renderPaneStrictly(
      contextFor(ARTIFACT_ENTITY, {
        bridge: artifactBridgeAnswering({ listAnswer: LISTED_ONE_ROW, clock }),
        sessionId: SESSION_ID,
      }),
    );

    await readThrough(clock);
    await settleAct();
    expect(container.querySelector(".meridian-artifact-row")).not.toBeNull();
  });

  it("keeps one reader across a re-render at the same artifact", async () => {
    // What the memo could not promise. React documents a memo as a cache it MAY
    // discard, and a discard at unchanged dependencies constructed a second reader
    // mid-render — the pane blanking to its unread absence and re-running a whole read
    // pair for no participant action. The seam holds the reader in state React owns,
    // so a re-render at the same subject reaches the same one: the row stands and the
    // port is not asked again.
    const clock = new ManualClock();
    const artifactList = vi.fn<() => Promise<unknown>>().mockResolvedValue(LISTED_ONE_ROW);
    const sessionStore = new SessionStore({ sessionId: SESSION_ID });
    const bridge = artifactBridgeAnswering({ artifactList, clock });
    const announcerClock = new ManualClock();
    const { container, rerender } = render(
      paneTree(contextFor(ARTIFACT_ENTITY, { bridge, sessionStore }), announcerClock),
    );

    await readThrough(clock);
    await settleAct();
    expect(container.querySelector(".meridian-artifact-row")).not.toBeNull();
    expect(artifactList).toHaveBeenCalledTimes(1);

    // A FRESH context object at the same address, which is what the deck composes on
    // every one of its renders: the address is a value and the subject is the id in it.
    rerender(paneTree(contextFor(ARTIFACT_ENTITY, { bridge, sessionStore }), announcerClock));
    await settleAct();

    expect(container.querySelector(".meridian-artifact-row")).not.toBeNull();
    expect(artifactList).toHaveBeenCalledTimes(1);
  });

  it("mints a reader of its own when the pane moves to another artifact", async () => {
    // The subject IS the key, so a moved subject is a new reader — and the pane opens
    // on the new artifact's not-read absence rather than on the previous one's rows.
    const clock = new ManualClock();
    const artifactList = vi.fn<() => Promise<unknown>>().mockResolvedValue(LISTED_ONE_ROW);
    const sessionStore = new SessionStore({ sessionId: SESSION_ID });
    const bridge = artifactBridgeAnswering({ artifactList, clock });
    const announcerClock = new ManualClock();
    const { container, rerender } = render(
      paneTree(contextFor(ARTIFACT_ENTITY, { bridge, sessionStore }), announcerClock),
    );

    await readThrough(clock);
    await settleAct();
    expect(artifactList).toHaveBeenCalledTimes(1);

    rerender(paneTree(contextFor(OTHER_ARTIFACT_ENTITY, { bridge, sessionStore }), announcerClock));
    await settleAct();
    // The new reader has read nothing yet, and says so rather than showing the rows
    // the previous subject's reader had already listed.
    expect(container.querySelector(".meridian-artifact-row")).toBeNull();

    await readThrough(clock);
    await settleAct();
    expect(artifactList).toHaveBeenCalledTimes(2);
  });

  it("mints a reader of its own when the session projection is replaced", async () => {
    // The store is not part of the seam's key — an artifact id already names one
    // session — so a projection rebuilt across a reconnect is caught by asking the
    // reader instead. Without that arm the pane would go on observing a retired store
    // and never hear another artifact frame from the live one.
    const clock = new ManualClock();
    const artifactList = vi.fn<() => Promise<unknown>>().mockResolvedValue(LISTED_ONE_ROW);
    const bridge = artifactBridgeAnswering({ artifactList, clock });
    const announcerClock = new ManualClock();
    const { rerender } = render(
      paneTree(
        contextFor(ARTIFACT_ENTITY, {
          bridge,
          sessionStore: new SessionStore({ sessionId: SESSION_ID }),
        }),
        announcerClock,
      ),
    );

    await readThrough(clock);
    await settleAct();
    expect(artifactList).toHaveBeenCalledTimes(1);

    rerender(
      paneTree(
        contextFor(ARTIFACT_ENTITY, {
          bridge,
          sessionStore: new SessionStore({ sessionId: SESSION_ID }),
        }),
        announcerClock,
      ),
    );
    await settleAct();
    await readThrough(clock);
    await settleAct();

    expect(artifactList).toHaveBeenCalledTimes(2);
  });

  it("negative control: an unmounted pane's reader is disposed and reads no more", async () => {
    // Both halves of the over-reach a re-mint arm invites. A binding that answered the
    // double-mount by never disposing would leave a torn-down pane still scheduling —
    // and one that re-minted on every effect run would read forever. Neither survives
    // an unmount: the seam's own cleanup disposes what the last commit held, and a
    // clock advanced afterwards reaches nothing.
    const clock = new ManualClock();
    const artifactList = vi.fn<() => Promise<unknown>>().mockResolvedValue(LISTED_ONE_ROW);
    const { unmount } = renderPane(
      contextFor(ARTIFACT_ENTITY, {
        bridge: artifactBridgeAnswering({ artifactList, clock }),
        sessionId: SESSION_ID,
      }),
    );

    await readThrough(clock);
    await settleAct();
    expect(artifactList).toHaveBeenCalledTimes(1);

    unmount();
    await readThrough(clock);
    await settleAct();
    expect(artifactList).toHaveBeenCalledTimes(1);
  });
});

describe("artifact pane — the instant a row's age is read against", () => {
  it("renders an age from the reader's clock, so a frozen scenario renders one text", async () => {
    // The defect: the pane read `Date.now()` in its render body. `test/console/repos-surfaces.tsx`
    // recorded the consequence in its own words — the pane built a clock behind the
    // binding and no surface could hand it one — so a screenshot subject that listed a
    // row pinned text derived from real wall-clock time against a fixture `createdAt`,
    // and the same subject rendered differently the next month.
    //
    // The reading now carries the instant the READER took, off the window's own clock.
    // Under the fixture that clock is frozen at the scenario's epoch, so the row's age
    // is a fixed distance from a fixed `createdAt`: `SERVED_SUMMARY` is stamped in 2026
    // and this clock starts at zero, so the row says the artifact is twenty thousand
    // days in the future — a text no wall clock can produce.
    const clock = new ManualClock();
    const { container } = renderPane(
      contextFor(ARTIFACT_ENTITY, {
        bridge: artifactBridgeAnswering({ listAnswer: LISTED_ONE_ROW, clock }),
        sessionId: SESSION_ID,
      }),
    );
    await readThrough(clock);
    await settleAct();

    const age = container.querySelector(".meridian-artifact-row")?.textContent ?? "";
    expect(age).toContain("in 20,698 days");
  });

  it("holds that age still while the pane re-renders under it", async () => {
    // The other half of the rule: an age moves when the READ moves and on no other
    // occasion. A body reading the wall clock moves it on any unrelated re-render —
    // and one that advanced on a timer would be the interval poll the budget forbids,
    // wearing a clock face.
    const clock = new ManualClock();
    const sessionStore = new SessionStore({ sessionId: SESSION_ID });
    const bridge = artifactBridgeAnswering({ listAnswer: LISTED_ONE_ROW, clock });
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
