// Plan-003 Phase 5 T5.3 — MixedVersionStatus renderer component suite.
//
// BL-131 exit criterion (b), this view's share: bridge-only data access (no
// `node:*` / `electron` / daemon / control-plane imports), the render states,
// and below-floor read-only surfacing of the typed `VERSION_FLOOR_EXCEEDED`
// refusal. Criterion (c) — the two-client attach E2E that replaces the T5.4
// manual smoke — is out of scope here and stays open on Plan-023 Tier 8.
//
// Spec coverage:
//   • `Spec-003 §Acceptance Criteria` AC4 (a below-floor node is admitted in a
//     read-only state, surfaces the typed `VERSION_FLOOR_EXCEEDED` outcome of a
//     version-sensitive write, and is never ejected for the mismatch): the
//     access-verdict cases pin the read-only label to the server-resolved
//     `readOnly` axis, the refusal cases pin the typed envelope's code and
//     message surfacing verbatim, and every refusal case asserts the node block
//     still renders — the never-ejected clause, structurally.
//   • I-003-1 (admit-not-eject — and the T5.3 posture that this view NEVER
//     re-derives the floor verdict): the tripwire case renders a `read-write`
//     entry TOGETHER WITH a `version.floor_exceeded` write rejection and
//     asserts the access verdict stays `read-write`. A view that inferred the
//     verdict from the refusal would flip it and fail here.
//   • Spec-023 §Trust Stance + `Plan-003 §Cross-Plan Obligations` CP-003-3: the
//     bridge-projection source scan at the bottom of this file.
//
// Harness: the Vitest `renderer` project (happy-dom) + `@testing-library/react`
// — the shipped desktop renderer stack; `ADR-022 §Decision Log` (2026-08-25)
// records why renderer component tests run there rather than under Browser
// Mode. `globals: true` supplies `describe`/`it`/`expect`; the renderer test
// tsconfig adds `vitest/globals` to `types`.
//
// This view is PROPS-ONLY — it touches no bridge arm — so no `window.sidekicks`
// mock is installed here; the sibling NodeRoster / AttachFlow suites carry the
// typed-arm mock. Queries are accessible-first (`getByRole` / `getByLabelText`);
// `data-*` assertions are reserved for the deliberate machine-readable enum
// tokens the view emits for exactly that purpose.

import { render, screen } from "@testing-library/react";

import { VERSION_FLOOR_EXCEEDED_CODE } from "@ai-sidekicks/contracts";
import type {
  EventEnvelopeVersion,
  NodeId,
  ParticipantId,
  RuntimeNodeRosterEntry,
  VersionFloorExceededError,
} from "@ai-sidekicks/contracts";

import { MixedVersionStatus } from "../MixedVersionStatus.js";

// --------------------------------------------------------------------------
// CP-003-3 source-text read — Vite `import.meta.glob` raw form.
// --------------------------------------------------------------------------
//
// The bridge-projection assertion needs the view's source TEXT. Vite's
// `import.meta.glob(..., { query: "?raw" })` inlines it as a string at
// transform time with NO module import, which is the only lint-clean /
// typecheck-clean option here: `node:fs` is doubly banned in this program — by
// the renderer `no-restricted-imports` rule (which covers `__tests__`) and by
// the renderer test typegraph's no-`@types/node` posture. The local
// `ImportMeta` augmentation declares the single signature used; it is scoped to
// this test program and does not leak into the production renderer typecheck.
// (Same shape as the shipped session-members suites.)
declare global {
  interface ImportMeta {
    glob: (
      pattern: string,
      options: { query: "?raw"; import: "default"; eager: true },
    ) => Record<string, string>;
  }
}

const runtimeNodeViewSources = import.meta.glob("../*.tsx", {
  query: "?raw",
  import: "default",
  eager: true,
});

// Branded id fixtures — the `"<uuid>" as NodeId` form mirrors the shipped
// renderer + SDK precedent.
const ATTACHED_NODE_ID = "01970000-0000-7000-8000-0000000000c1" as NodeId;
const OWNING_PARTICIPANT_ID = "01970000-0000-7000-8000-0000000000b1" as ParticipantId;
const BELOW_FLOOR_CLIENT_VERSION = "1.0" as EventEnvelopeVersion;
const AT_FLOOR_CLIENT_VERSION = "2.0" as EventEnvelopeVersion;

// A roster entry as the control-plane `readRoster` projection emits it. The
// default is the at-floor, read-write, healthy case; each test overrides only
// the axis it is pinning, so an unrelated field drifting cannot silently change
// what a case proves.
function buildRosterEntry(overrides: Partial<RuntimeNodeRosterEntry> = {}): RuntimeNodeRosterEntry {
  return {
    nodeId: ATTACHED_NODE_ID,
    participantId: OWNING_PARTICIPANT_ID,
    state: "online",
    healthState: "online",
    lastHeartbeatAt: "2026-06-10T10:00:00.000Z",
    readOnly: false,
    capabilities: { "shell.exec": true },
    clientVersion: AT_FLOOR_CLIENT_VERSION,
    attachedAt: "2026-06-10T09:59:00.000Z",
    ...overrides,
  };
}

// The real typed refusal envelope, built from the shipped contract type and the
// shipped code constant — not a hand-rolled literal. If the wire code moves,
// this fixture moves with it and the recognizer test still pins the real seam.
const FLOOR_REFUSAL_MESSAGE = "client version 1.0 is below the session floor 2.0";
const FLOOR_REFUSAL_ENVELOPE: VersionFloorExceededError = {
  code: VERSION_FLOOR_EXCEEDED_CODE,
  message: FLOOR_REFUSAL_MESSAGE,
  details: {
    attemptedVersion: "1.0",
    acceptedRange: { min: "2.0", max: "2.0" },
  },
};

describe("MixedVersionStatus (Plan-003 Phase 5 T5.3)", () => {
  describe("access verdict (server-resolved, never re-derived)", () => {
    it("renders the below-floor read-only verdict off the wire `readOnly` axis", () => {
      render(
        <MixedVersionStatus
          rosterEntry={buildRosterEntry({
            readOnly: true,
            clientVersion: BELOW_FLOOR_CLIENT_VERSION,
          })}
          writeAttemptRejection={null}
        />,
      );

      const statusSection = screen.getByLabelText("mixed-version-status");
      expect(statusSection.getAttribute("data-access-status")).toBe("read-only");
      expect(statusSection.getAttribute("data-read-only")).toBe("true");
      expect(screen.getByText("access: read-only (below version floor)")).toBeDefined();
      // The node stays visible and its declared version is legible — the
      // below-floor node is annotated, not hidden.
      expect(
        screen.getByText(`declared client version: ${BELOW_FLOOR_CLIENT_VERSION}`),
      ).toBeDefined();
    });

    it("renders the at-floor read-write verdict", () => {
      render(<MixedVersionStatus rosterEntry={buildRosterEntry()} writeAttemptRejection={null} />);

      const statusSection = screen.getByLabelText("mixed-version-status");
      expect(statusSection.getAttribute("data-access-status")).toBe("read-write");
      expect(statusSection.getAttribute("data-read-only")).toBe("false");
      expect(screen.getByText("access: read-write")).toBeDefined();
    });

    it("resolves the read-only verdict on the `registering` node state too", () => {
      // `registering` shares the floor-sensitive arm with `online`/`degraded`:
      // a node still registering below the floor is already read-only.
      render(
        <MixedVersionStatus
          rosterEntry={buildRosterEntry({
            state: "registering",
            healthState: null,
            readOnly: true,
          })}
          writeAttemptRejection={null}
        />,
      );

      const statusSection = screen.getByLabelText("mixed-version-status");
      expect(statusSection.getAttribute("data-access-status")).toBe("read-only");
      expect(statusSection.getAttribute("data-node-state")).toBe("registering");
    });

    it("keeps a `degraded` node read-write when it is at the floor", () => {
      // Liveness (`degraded`) and authority (`readOnly`) are ORTHOGONAL axes:
      // a degraded node at the floor still writes.
      render(
        <MixedVersionStatus
          rosterEntry={buildRosterEntry({ state: "degraded", healthState: "degraded" })}
          writeAttemptRejection={null}
        />,
      );

      const statusSection = screen.getByLabelText("mixed-version-status");
      expect(statusSection.getAttribute("data-access-status")).toBe("read-write");
      expect(statusSection.getAttribute("data-node-state")).toBe("degraded");
    });

    it("renders `detached` for an offline node", () => {
      render(
        <MixedVersionStatus
          rosterEntry={buildRosterEntry({ state: "offline", healthState: "offline" })}
          writeAttemptRejection={null}
        />,
      );

      expect(screen.getByLabelText("mixed-version-status").getAttribute("data-access-status")).toBe(
        "detached",
      );
      expect(screen.getByText("access: detached (no active attachment)")).toBeDefined();
    });

    it("renders `revoked` for a revoked node, distinct from plain detachment", () => {
      render(
        <MixedVersionStatus
          rosterEntry={buildRosterEntry({ state: "revoked", healthState: null })}
          writeAttemptRejection={null}
        />,
      );

      expect(screen.getByLabelText("mixed-version-status").getAttribute("data-access-status")).toBe(
        "revoked",
      );
      expect(
        screen.getByText("access: revoked (authority-issued; re-attach is refused)"),
      ).toBeDefined();
    });

    it("renders `detached` with no node facts when there is no roster entry", () => {
      render(<MixedVersionStatus rosterEntry={null} writeAttemptRejection={null} />);

      const statusSection = screen.getByLabelText("mixed-version-status");
      expect(statusSection.getAttribute("data-access-status")).toBe("detached");
      // No entry means no state and no authority axis to project — both
      // attributes are absent rather than guessed.
      expect(statusSection.getAttribute("data-node-state")).toBeNull();
      expect(statusSection.getAttribute("data-read-only")).toBeNull();
      expect(screen.queryByLabelText("mixed-version-node-facts")).toBeNull();
      expect(
        screen.getByText("node: no roster entry (not attached to this session)"),
      ).toBeDefined();
    });
  });

  describe("write-refusal surfacing", () => {
    it("renders the no-refusal state with no alert at all", () => {
      render(<MixedVersionStatus rosterEntry={buildRosterEntry()} writeAttemptRejection={null} />);

      expect(screen.queryByRole("alert")).toBeNull();
      expect(
        screen.getByText("no refused write attempt to surface").getAttribute("data-write-refusal"),
      ).toBe("none");
    });

    it("treats an `undefined` rejection as no refusal (not as an unrecognized one)", () => {
      render(
        <MixedVersionStatus rosterEntry={buildRosterEntry()} writeAttemptRejection={undefined} />,
      );

      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.getByText("no refused write attempt to surface")).toBeDefined();
    });

    it("surfaces the typed VERSION_FLOOR_EXCEEDED envelope verbatim and keeps the node visible", () => {
      // `Spec-003 §Acceptance Criteria` AC4: the typed refusal is surfaced, and
      // the node is NOT ejected — the node facts render on the refusal arm.
      render(
        <MixedVersionStatus
          rosterEntry={buildRosterEntry({
            readOnly: true,
            clientVersion: BELOW_FLOOR_CLIENT_VERSION,
          })}
          writeAttemptRejection={FLOOR_REFUSAL_ENVELOPE}
        />,
      );

      const refusalAlert = screen.getByRole("alert", { name: "version-floor-write-refusal" });
      expect(refusalAlert.getAttribute("data-write-refusal")).toBe(VERSION_FLOOR_EXCEEDED_CODE);
      expect(refusalAlert.textContent).toContain(VERSION_FLOOR_EXCEEDED_CODE);
      expect(refusalAlert.textContent).toContain(FLOOR_REFUSAL_MESSAGE);
      expect(refusalAlert.textContent).toContain(
        "the node remains joined and readable — admitted read-only, not ejected",
      );
      // Never ejected: the node block renders alongside the refusal.
      expect(screen.getByLabelText("mixed-version-node-facts")).toBeDefined();
      expect(screen.getByText(`node id: ${ATTACHED_NODE_ID}`)).toBeDefined();
    });

    it("does NOT let a floor refusal re-derive the access verdict (I-003-1 tripwire)", () => {
      // The verdict comes from the server-resolved `readOnly` axis ALONE. This
      // deliberately inconsistent pairing — a read-write entry plus a floor
      // refusal — must still render `read-write`. A view that inferred the
      // verdict from the refusal (re-deriving floor logic in the renderer)
      // would flip to `read-only` here.
      render(
        <MixedVersionStatus
          rosterEntry={buildRosterEntry({ readOnly: false })}
          writeAttemptRejection={FLOOR_REFUSAL_ENVELOPE}
        />,
      );

      const statusSection = screen.getByLabelText("mixed-version-status");
      expect(statusSection.getAttribute("data-access-status")).toBe("read-write");
      expect(screen.getByText("access: read-write")).toBeDefined();
      // …and the refusal is still surfaced on its own axis.
      expect(screen.getByRole("alert", { name: "version-floor-write-refusal" })).toBeDefined();
    });

    it("routes a non-floor wire-error envelope to the unrecognized arm, code preserved", () => {
      render(
        <MixedVersionStatus
          rosterEntry={buildRosterEntry()}
          writeAttemptRejection={{
            code: "runtimenode.permission_denied",
            message: "caller does not own this attachment",
          }}
        />,
      );

      const rejectionAlert = screen.getByRole("alert", { name: "unrecognized-write-rejection" });
      expect(rejectionAlert.getAttribute("data-write-refusal")).toBe("unrecognized");
      expect(rejectionAlert.textContent).toContain("runtimenode.permission_denied");
      expect(rejectionAlert.textContent).toContain("caller does not own this attachment");
      // It is NOT mistaken for the floor refusal.
      expect(screen.queryByRole("alert", { name: "version-floor-write-refusal" })).toBeNull();
    });

    it("renders a thrown Error's name and message on the unrecognized arm", () => {
      const transportFailure = new TypeError("Failed to fetch");
      render(
        <MixedVersionStatus
          rosterEntry={buildRosterEntry()}
          writeAttemptRejection={transportFailure}
        />,
      );

      const rejectionAlert = screen.getByRole("alert", { name: "unrecognized-write-rejection" });
      expect(rejectionAlert.textContent).toContain("TypeError");
      expect(rejectionAlert.textContent).toContain("Failed to fetch");
    });

    it("renders a non-object rejection through the string fallback", () => {
      render(
        <MixedVersionStatus
          rosterEntry={buildRosterEntry()}
          writeAttemptRejection={"bridge channel closed"}
        />,
      );

      expect(
        screen.getByRole("alert", { name: "unrecognized-write-rejection" }).textContent,
      ).toContain("bridge channel closed");
    });

    it("degrades a rejection that cannot be stringified to the lossy literal", () => {
      // `String(Object.create(null))` THROWS (ToPrimitive finds no
      // `toString`/`valueOf`/`Symbol.toPrimitive`), so this drives the view's
      // guarded terminal fallback rather than the ordinary string path. A
      // pathological rejection degrades; it never crashes the render.
      const unstringifiableRejection = Object.create(null) as unknown;
      expect(() => String(unstringifiableRejection)).toThrow();

      render(
        <MixedVersionStatus
          rosterEntry={buildRosterEntry()}
          writeAttemptRejection={unstringifiableRejection}
        />,
      );

      expect(
        screen.getByRole("alert", { name: "unrecognized-write-rejection" }).textContent,
      ).toContain("[unrepresentable value]");
      // The node block still renders — a bad rejection value cannot eject the node.
      expect(screen.getByLabelText("mixed-version-node-facts")).toBeDefined();
    });
  });

  describe("bridge-projection (CP-003-3)", () => {
    // Spec-023 §Trust Stance + Plan-003 CP-003-3, and BL-131 exit criterion (b)
    // ("assert bridge-only data access (no `node:*`/`electron` imports)"). The
    // renderer is the UNTRUSTED surface: it reaches the daemon / control plane
    // ONLY through the `window.sidekicks` preload bridge.
    //
    // `apps/desktop/eslint.config.mjs` already bans `electron` / `node:*` /
    // `**/main/**` / `**/preload/**` for renderer source, so those two arms are
    // belt-and-braces; the `@ai-sidekicks/runtime-daemon` /
    // `@ai-sidekicks/control-plane` arm has NO lint rule today (deferred to the
    // Plan-023 Tier 8 remainder), so for that arm this tripwire is the sole
    // operational enforcement.
    //
    // All three patterns anchor on the IMPORT SURFACE (`from "…"` / `import "…"`
    // / `import("…")`), never on bare words: these view sources discuss "the
    // local daemon" and spell "no `electron`, no `node:*`" in PROSE, which a
    // naive substring match would false-positive. The banned-module alternation
    // is written once and composed into the three surfaces, so the three cannot
    // drift apart.
    const bannedModuleSource =
      "(?:@ai-sidekicks/(?:runtime-daemon|control-plane)(?:/[^\"'`]*)?" +
      "|[^\"'`]*packages/(?:runtime-daemon|control-plane)/[^\"'`]*" +
      "|node:[^\"'`]+" +
      "|(?:fs|path|os|net|child_process|process)" +
      "|electron(?:/[^\"'`]*)?)";

    const bannedDirectImportPatterns: ReadonlyArray<readonly [string, RegExp, string]> = [
      [
        "bannedFromImport",
        new RegExp(`from\\s*["'\`]${bannedModuleSource}["'\`]`),
        'import { readFile } from "node:fs/promises";',
      ],
      [
        "bannedSideEffectImport",
        new RegExp(`import\\s*["'\`]${bannedModuleSource}["'\`]`),
        'import "@ai-sidekicks/control-plane";',
      ],
      [
        "bannedDynamicImport",
        new RegExp(`import\\s*\\(\\s*["'\`]${bannedModuleSource}["'\`]`),
        'const daemon = await import("@ai-sidekicks/runtime-daemon");',
      ],
    ];

    // Glob-key-drift guard, hoisted to run ONCE: if the `import.meta.glob` key
    // ever drifts, this throws loudly here rather than letting every case
    // vacuously pass against an `undefined` source.
    const mixedVersionStatusSource = runtimeNodeViewSources["../MixedVersionStatus.tsx"];
    if (typeof mixedVersionStatusSource !== "string") {
      throw new Error("MixedVersionStatus.tsx source was not loaded by import.meta.glob");
    }

    // Negative control: a tripwire that has never fired positive proves nothing.
    // Each pattern must MATCH a synthetic violating import before its clean
    // verdict on the real source below is worth anything.
    it.each(bannedDirectImportPatterns)(
      "%s matches a synthetic violating import (negative control)",
      (_bannedImportPatternName, bannedImportPattern, violatingImportSample) => {
        expect(bannedImportPattern.test(violatingImportSample)).toBe(true);
      },
    );

    it.each(bannedDirectImportPatterns)(
      "MixedVersionStatus.tsx source matches no %s",
      (_bannedImportPatternName, bannedImportPattern) => {
        expect(bannedImportPattern.test(mixedVersionStatusSource)).toBe(false);
      },
    );
  });
});
