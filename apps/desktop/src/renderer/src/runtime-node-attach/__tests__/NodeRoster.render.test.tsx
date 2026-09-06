// Plan-003 Phase 5 T5.1 — what the roster PROJECTS, and what it imports.
//
// One of the two halves this suite splits into, along the component's own seam:
// this file holds the render — the three states and the row facets — and
// `NodeRoster.read.test.tsx` holds when they change. Both mount through the shared
// seam builder in `node-roster.test-support.ts`.
//
// BL-131 exit criterion (b), this view's share: bridge-only data access (no
// `node:*` / `electron` / daemon / control-plane imports), the three render states
// (loading / loaded / error), and below-floor read-only surfacing of the typed
// `VERSION_FLOOR_EXCEEDED` refusal. Criterion (c) — the two-client attach E2E that
// replaces the T5.4 manual smoke — is out of scope here and stays open on Plan-023
// Tier 8.
//
// Spec coverage:
//   • `Spec-003 §Acceptance Criteria` AC4 (below-floor nodes are admitted
//     READ-ONLY and never ejected): the roster renders a below-floor row with its
//     read-only access label — the node is annotated, not filtered out.
//   • `Spec-003 §Required Behavior` (the roster is a FAITHFUL projection): every
//     row the wire returns renders, both health axes verbatim (`state` = the
//     authority/slot axis, `healthState` = the liveness axis), with no client-side
//     hiding, sorting, or re-derivation.
//   • I-003-1 (admit-not-eject): the below-floor row and the
//     `version.floor_exceeded` read-refusal case both keep the surface legible
//     rather than blanking it.
//   • Spec-023 §Trust Stance + `Plan-003 §Cross-Plan Obligations` CP-003-3: the view
//     reaches the control plane and the daemon through no path of its own. That is
//     now STRUCTURAL rather than mocked — `reads` is required and this view resolves
//     no transport — and the two controls below hold it: the untouched-global case
//     and the bridge-projection source scan.
//
// Harness: the Vitest `renderer` project (happy-dom) + `@testing-library/react` —
// see `ADR-022 §Decision Log` (2026-08-25) for why renderer component tests run
// there rather than under Browser Mode.
//
// RESPONSE DRIFT is caught by the annotated fixtures in the shared support module
// plus the `expectTypeOf` tripwire below, which makes that protection structural
// rather than incidental. Verified by mutation: a new required member on the
// response interface fails at the fixture lines.

import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";

import { NotImplementedAtTier1Error, VERSION_FLOOR_EXCEEDED_CODE } from "@ai-sidekicks/contracts";
import type {
  RuntimeNodeRosterEntry,
  RuntimeNodeRosterResponse,
  SidekicksBridge,
  VersionFloorExceededError,
} from "@ai-sidekicks/contracts";

import { NodeRoster } from "../NodeRoster.js";
import {
  AT_FLOOR_NODE_ID,
  FIRST_SESSION_ID,
  FIRST_SNAPSHOT,
  SECOND_SESSION_SNAPSHOT,
  buildRosterEntry,
  createDrivenSeam,
  seamServing,
} from "./node-roster.test-support.js";
import {
  BANNED_DIRECT_IMPORT_PATTERNS,
  runtimeNodeSourceNamed,
} from "./runtime-node-source.test-support.js";

// CP-003-3 source-text read. The raw glob and the banned-import pattern table
// live once, in `runtime-node-source.test-support.ts` — every suite in this
// directory had a verbatim copy of both.

// The drift tripwire, asserted rather than merely annotated. `toEqualTypeOf` is
// invariant, so widening `RuntimeNodeRosterResponse` or loosening a fixture
// annotation fails HERE, naming this contract.
expectTypeOf(FIRST_SNAPSHOT).toEqualTypeOf<RuntimeNodeRosterResponse>();
expectTypeOf(SECOND_SESSION_SNAPSHOT).toEqualTypeOf<RuntimeNodeRosterResponse>();
expectTypeOf(
  buildRosterEntry({ nodeId: AT_FLOOR_NODE_ID }),
).toEqualTypeOf<RuntimeNodeRosterEntry>();

const FLOOR_REFUSAL_MESSAGE = "client version 1.0 is below the session floor 2.0";
const FLOOR_REFUSAL_ENVELOPE: VersionFloorExceededError = {
  code: VERSION_FLOOR_EXCEEDED_CODE,
  message: FLOOR_REFUSAL_MESSAGE,
  details: {
    attemptedVersion: "1.0",
    acceptedRange: { min: "2.0", max: "2.0" },
  },
};

describe("NodeRoster", () => {
  afterEach(() => {
    delete (window as unknown as { sidekicks?: SidekicksBridge }).sidekicks;
    vi.clearAllMocks();
  });

  describe("loading state", () => {
    it("renders the busy loading section before the mount read resolves", () => {
      // Mount-triggered view: it STARTS in `loading`. An un-settling read keeps it
      // there so the synchronous query observes the in-flight branch.
      const seam = createDrivenSeam({ readRoster: () => new Promise(() => {}) });

      render(<NodeRoster sessionId={FIRST_SESSION_ID} reads={seam.reads} />);

      const loadingSection = screen.getByLabelText("node-roster-loading");
      expect(loadingSection.getAttribute("aria-busy")).toBe("true");
      // The seam takes the registered REQUEST and no procedure name: which procedure
      // answers a roster read is the wire's fact, and this view no longer holds it.
      expect(seam.readRoster).toHaveBeenCalledWith({ sessionId: FIRST_SESSION_ID });
    });

    it("subscribes to the presence signal BEFORE issuing the first read", () => {
      // Subscribe-before-read: a transition that lands while the first read is in
      // flight must not be missed. Reversing the order in the view would open exactly
      // that window, and this ordering proof is what closes it.
      const seam = createDrivenSeam({ readRoster: () => new Promise(() => {}) });

      render(<NodeRoster sessionId={FIRST_SESSION_ID} reads={seam.reads} />);

      expect(seam.subscribePresence).toHaveBeenCalledWith(
        FIRST_SESSION_ID,
        expect.any(Function) as unknown as () => void,
      );
      const [subscribeInvocationOrder] = seam.subscribePresence.mock.invocationCallOrder;
      const [readInvocationOrder] = seam.readRoster.mock.invocationCallOrder;
      expect(subscribeInvocationOrder).toBeLessThan(readInvocationOrder as number);
    });

    it("reads through the supplied seam and touches no installed bridge", async () => {
      // The control that replaced the retired default arm. This view used to fall
      // back to `window.sidekicks` and to a second copy of the two wire strings; a
      // global whose every access throws proves the fallback is gone rather than
      // merely unused, and it fails on the old code at the first render.
      const forbiddenGlobal = new Proxy(
        {},
        {
          get: () => {
            throw new Error("NodeRoster reached the installed bridge");
          },
        },
      );
      (window as unknown as { sidekicks: SidekicksBridge }).sidekicks =
        forbiddenGlobal as SidekicksBridge;
      const seam = seamServing(FIRST_SNAPSHOT);

      render(<NodeRoster sessionId={FIRST_SESSION_ID} reads={seam.reads} />);

      await screen.findByText(`node id: ${AT_FLOOR_NODE_ID}`);
      expect(seam.readRoster).toHaveBeenCalledWith({ sessionId: FIRST_SESSION_ID });
    });
  });

  describe("loaded projection", () => {
    it("renders every wire row with both health axes verbatim", async () => {
      render(<NodeRoster sessionId={FIRST_SESSION_ID} reads={seamServing(FIRST_SNAPSHOT).reads} />);

      const loadedSection = await screen.findByLabelText("node-roster-loaded");
      const renderedRows = loadedSection.querySelectorAll("li");
      expect(renderedRows).toHaveLength(FIRST_SNAPSHOT.nodes.length);
      for (const rosterEntry of FIRST_SNAPSHOT.nodes) {
        expect(screen.getByText(`node id: ${rosterEntry.nodeId}`)).toBeDefined();
      }
      // Slot axis (`state`) and liveness axis (`healthState`) render SEPARATELY — the
      // degraded below-floor node carries both.
      const belowFloorRow = loadedSection.querySelector(
        `li[data-node-state="degraded"][data-health-state="degraded"]`,
      );
      expect(belowFloorRow).not.toBeNull();
    });

    // `Spec-003 §Acceptance Criteria` AC4.
    it("renders a below-floor node read-only rather than dropping it", async () => {
      render(<NodeRoster sessionId={FIRST_SESSION_ID} reads={seamServing(FIRST_SNAPSHOT).reads} />);

      const loadedSection = await screen.findByLabelText("node-roster-loaded");
      const readOnlyRows = loadedSection.querySelectorAll('li[data-read-only="true"]');
      expect(readOnlyRows).toHaveLength(1);
      expect(screen.getByText("access: read-only (below version floor)")).toBeDefined();
      // …and the at-floor nodes are unaffected.
      expect(loadedSection.querySelectorAll('li[data-read-only="false"]')).toHaveLength(2);
    });

    it("renders a node with no heartbeat yet without inventing a liveness value", async () => {
      render(<NodeRoster sessionId={FIRST_SESSION_ID} reads={seamServing(FIRST_SNAPSHOT).reads} />);

      const loadedSection = await screen.findByLabelText("node-roster-loaded");
      const registeringRow = loadedSection.querySelector('li[data-node-state="registering"]');
      expect(registeringRow).not.toBeNull();
      // A null liveness axis is ABSENT from the machine-readable facet rather than
      // coerced to a state the node never reported.
      expect(registeringRow?.getAttribute("data-health-state")).toBeNull();
      expect(screen.getByText("liveness: none (no heartbeat yet)")).toBeDefined();
      expect(screen.getByText("last heartbeat: none (no heartbeat yet)")).toBeDefined();
    });

    it("renders the loaded (not error, not loading) state for an empty roster", async () => {
      // A session with no attachments is a legitimate empty projection.
      render(<NodeRoster sessionId={FIRST_SESSION_ID} reads={seamServing({ nodes: [] }).reads} />);

      const loadedSection = await screen.findByLabelText("node-roster-loaded");
      expect(loadedSection.querySelectorAll("li")).toHaveLength(0);
      expect(screen.queryByLabelText("node-roster-error")).toBeNull();
      expect(screen.queryByLabelText("node-roster-loading")).toBeNull();
    });
  });

  describe("error state", () => {
    it("surfaces a typed version-floor read refusal with its wire code as the error name", async () => {
      const seam = createDrivenSeam({
        readRoster: async () => await Promise.reject(FLOOR_REFUSAL_ENVELOPE),
      });

      render(<NodeRoster sessionId={FIRST_SESSION_ID} reads={seam.reads} />);

      const errorSection = await screen.findByRole("alert", { name: "node-roster-error" });
      expect(errorSection.textContent).toContain(VERSION_FLOOR_EXCEEDED_CODE);
      expect(errorSection.textContent).toContain(FLOOR_REFUSAL_MESSAGE);
    });

    it("surfaces a thrown Error's name and message", async () => {
      const seam = createDrivenSeam({
        readRoster: async () => await Promise.reject(new TypeError("control plane unreachable")),
      });

      render(<NodeRoster sessionId={FIRST_SESSION_ID} reads={seam.reads} />);

      const errorSection = await screen.findByRole("alert", { name: "node-roster-error" });
      expect(errorSection.textContent).toContain("TypeError");
      expect(errorSection.textContent).toContain("control plane unreachable");
    });

    it("renders the error state when the seam's subscribe throws synchronously", async () => {
      // A host with no live channel throws here for the same reason the Tier-1 bridge
      // stub does. The view must degrade to its error state rather than letting the
      // throw escape the effect — and, since subscribe runs first, the roster read is
      // never issued, so nothing paints a snapshot with no channel behind it.
      const seam = createDrivenSeam({
        readRoster: async () => await Promise.resolve(FIRST_SNAPSHOT),
        subscribeThrows: new NotImplementedAtTier1Error("daemon.subscribe"),
      });

      render(<NodeRoster sessionId={FIRST_SESSION_ID} reads={seam.reads} />);

      const errorSection = await screen.findByRole("alert", { name: "node-roster-error" });
      expect(errorSection.textContent).toContain("NotImplementedAtTier1Error");
      expect(seam.readRoster).not.toHaveBeenCalled();
    });
  });

  describe("bridge-projection", () => {
    // Spec-023 §Trust Stance + Plan-003 CP-003-3, and BL-131 exit criterion (b)
    // ("assert bridge-only data access (no `node:*`/`electron` imports)"). The
    // `@ai-sidekicks/runtime-daemon` / `@ai-sidekicks/control-plane` arm has no lint
    // rule today (deferred to the Plan-023 Tier 8 remainder), so for that arm this
    // tripwire is the sole operational enforcement.
    //
    // The pattern table is `runtime-node-source.test-support.ts`'s. What stays here
    // is WHICH modules the claim is about, and it is BOTH of this view's: the
    // rendering and `node-roster-reads.ts`, where the wire calls actually live. A
    // scan of the `.tsx` alone would have been blind to exactly the module that
    // talks to the control plane.
    const nodeRosterSources = ["../NodeRoster.tsx", "../node-roster-reads.ts"].map(
      runtimeNodeSourceNamed,
    );

    // Negative control: a tripwire that has never fired positive proves nothing.
    it.each(BANNED_DIRECT_IMPORT_PATTERNS)(
      "%s matches a synthetic violating import (negative control)",
      (_bannedImportPatternName, bannedImportPattern, violatingImportSample) => {
        expect(bannedImportPattern.test(violatingImportSample)).toBe(true);
      },
    );

    it.each(BANNED_DIRECT_IMPORT_PATTERNS)(
      "the roster's own modules match no %s",
      (_bannedImportPatternName, bannedImportPattern) => {
        for (const source of nodeRosterSources) {
          expect(bannedImportPattern.test(source)).toBe(false);
        }
      },
    );
  });
});
