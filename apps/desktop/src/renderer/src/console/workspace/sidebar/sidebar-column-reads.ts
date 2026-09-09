// What the column reads, beside what it renders.
//
// TWO HOOKS AND THE SENTENCE ONE OF THEM SPEAKS, lifted out of `Sidebar.tsx` because
// neither is about the column's markup: one folds every section's own rollup into the
// map the model decides from, and the other says once what the restored arrangement
// came back as. Keeping them here leaves that file the column and this file the reads,
// which is the same split `model/` and `persistence/` already make one level down.

import { useEffect, useMemo } from "react";

import type { ConsoleBridge } from "../../bridge/index.js";
import { useAnnounceOncePerSentence } from "../../primitives/index.js";
import {
  SIDEBAR_SECTION_IDS,
  type SidebarSectionId,
  type SidebarSectionRegistry,
} from "../../seats/index.js";
import {
  useSessionProjectionRevision,
  useSubjectScopedState,
  type FrameStore,
  type SessionStore,
} from "../../store/index.js";
import { SIDEBAR_SECTION_LABELS } from "./model/sidebar-labels.js";
import { foldSectionRollup, type SectionRollup } from "./model/section-rollup.js";
import type {
  SidebarAttentionBySectionId,
  SidebarModel,
  SidebarSnapshot,
} from "./model/sidebar-model.js";

/** What each section's tree folded to. Absent means the section supplied no tree. */
export type SidebarRollupBySectionId = Readonly<Partial<Record<SidebarSectionId, SectionRollup>>>;

/** Both readings the column takes off the seat in one pass over the descriptors. */
export interface SidebarSectionReadings {
  readonly attentionBySectionId: SidebarAttentionBySectionId;
  readonly rollupBySectionId: SidebarRollupBySectionId;
}

/**
 * Read every section's own rollup, and hand the attention map to the model.
 *
 * THE PROJECTION MOVES UNDER THIS COLUMN, and the containers it moves inside do not. A
 * section reports off its own family's projection of the session store, and that store
 * keeps ONE identity for the life of the session — so a memo keyed on the registry and
 * the two containers would be computed once at mount and never again, and an approval
 * that arrived a second later would reach no marker, open no section, and stay marked
 * after it resolved. The store's own transition counter is the value that says the
 * projection moved; it is what the readers are reading behind.
 *
 * ONE SUBSCRIPTION FOR THE COLUMN, not one per section: the counter names no partition,
 * so eight of them would deliver the same number eight times.
 *
 * ONE PASS FOR BOTH READINGS. The tree and the level answer the same question at two
 * grains, and a section that supplies a tree has its level FOLDED from it rather than
 * asked for separately — `SidebarSectionDescriptor.rollup` states that precedence, and
 * this is where it is applied: the explicit claim wins, the fold stands in where there
 * is none, and neither is computed twice.
 *
 * Handed over from an EFFECT rather than during the render that computed it, because
 * the model's own rule opens a newly calling section — a state change, and a component
 * that moved its parent's state mid-pass would be rendering and writing at once. The
 * model compares before it publishes, so an unchanged map from an unrelated re-render
 * costs one comparison and no re-render.
 */
export function useSectionAttention(
  model: SidebarModel,
  sectionRegistry: SidebarSectionRegistry,
  sessionStore: SessionStore,
  bridge: ConsoleBridge,
  frameStore: FrameStore,
): SidebarRollupBySectionId {
  const projectionRevision = useSessionProjectionRevision(sessionStore);
  const readings = useMemo<SidebarSectionReadings>(() => {
    const attention: Partial<Record<SidebarSectionId, "attention" | "failure">> = {};
    const rollupBySectionId: Partial<Record<SidebarSectionId, SectionRollup>> = {};
    for (const sectionId of SIDEBAR_SECTION_IDS) {
      const descriptor = sectionRegistry.descriptorFor(sectionId);
      if (descriptor === undefined) {
        continue;
      }
      const context = { sessionStore, bridge, frameStore };
      const nodes = descriptor.rollup?.(context);
      const folded = nodes === undefined ? undefined : foldSectionRollup(nodes);
      if (folded !== undefined) {
        rollupBySectionId[sectionId] = folded;
      }
      const reported = descriptor.attention?.(context) ?? folded?.attention;
      if (reported !== undefined) {
        attention[sectionId] = reported;
      }
    }
    return { attentionBySectionId: attention, rollupBySectionId };
    // `projectionRevision` is read by the readers above rather than by this body, which
    // is the whole of why it is here: it is the dependency that makes them re-run.
  }, [sectionRegistry, sessionStore, bridge, frameStore, projectionRevision]);

  useEffect(() => {
    model.syncAttention(readings.attentionBySectionId);
  }, [model, readings]);

  return readings.rollupBySectionId;
}

/**
 * What one session's settlement turned out to say, frozen at the moment it settled.
 *
 * NOT A LATCH, and the distinction is the whole point of this class. Whether a sentence
 * has already been SPOKEN is `primitives/announce/reading-announcement.ts`'s one ref and nothing
 * else's — a second copy of that comparison is a sentence a person hears twice with
 * every test still green. What lives here is a different fact the latch cannot hold: a
 * settlement describes the arrangement a session came back WITH, and the column keeps
 * moving afterwards, so the words have to be captured at the transition rather than
 * recomputed from whatever the snapshot says three section-toggles later.
 *
 * A HOLDER AND NOT RENDER STATE, on `RestoreProgress`' own reading: nothing draws this,
 * and publishing it would re-render the whole column for a fact no part of it shows.
 * What it is ADDRESSED by is the point, and that is the caller's — one of these per
 * model, so the settlement it describes is the settlement of the session that model is
 * about.
 */
class SidebarSettlementSentences {
  #captured: readonly string[] = [];
  #hasCaptured = false;

  /**
   * What this session has to say, capturing it on the first settled pass.
   *
   * Idempotent, so the render that addresses a new subject may call it and a second
   * pass over the same snapshot changes nothing — and the array it hands back keeps one
   * identity for the life of the session, which is what makes it a stable dependency
   * for the latch's effect.
   *
   * AN EMPTY ARRAY UNTIL THEN, deliberately, and never `undefined`. The latch treats an
   * array as a REPLACEMENT of what it last said and `undefined` as no claim at all — so
   * an unsettled session retracts the previous session's sentence, which is exactly
   * true: that settlement was about a session no longer on screen. `SidebarModel` is
   * constructed unsettled and reaches `hasSettled` only through `restore`, so every
   * re-minted model necessarily passes through at least one retracting pass before it
   * can speak. That is what lets two sessions whose arrangements read the same both be
   * announced, which a mount-lifetime memory of the sentence alone would not.
   */
  public capturedFrom(snapshot: SidebarSnapshot): readonly string[] {
    if (!this.#hasCaptured && snapshot.hasSettled) {
      this.#hasCaptured = true;
      const sentence = settlementSentence(snapshot);
      this.#captured = sentence === undefined ? [] : [sentence];
    }
    return this.#captured;
  }
}

/**
 * Say what the sidebar came back as, once, when its saved arrangement settles.
 *
 * Not on a re-render, not when the person opens a section, and not when there is
 * nothing to report. `hasSettled` only ever goes false to true for one model, so the
 * capture above is the transition itself.
 *
 * NAMED FOR THE SIDEBAR, because the general name is the primitive's. Two exported hooks
 * called `useSettlementAnnouncement` — one taking a sentence, one taking three arguments
 * — were two contracts under one name across the console DAG, which is the shape a
 * reader resolves by opening whichever file they happened to land in.
 *
 * ONCE PER SESSION AND NOT ONCE PER MOUNT, which is the same distinction the deck's
 * persistence draws and for the same cause: the workspace stays mounted across a route
 * between two open sessions, and the sidebar's model is re-minted with the session. A
 * memory that lived for the mount stayed set after the first session's settlement, so
 * the second session's saved open-section state — or its restore refusal — changed the
 * column in front of somebody in silence, which is the one thing a live region is for.
 * The MODEL is the subject rather than the session id, because it is the thing whose
 * settlement this describes and it is re-minted per session already; a second reading of
 * which session is on screen could disagree with it.
 *
 * AND ONLY WHERE THE SETTLED STATE SAYS SOMETHING THE COLUMN DOES NOT. A sidebar that
 * restored nothing and opened nothing is a sidebar a person is looking at, and
 * announcing it would spend the window's one polite lane on it — the announcer
 * serialises, so a sentence nobody needed delays the next one that somebody does.
 */
export function useSidebarSettlementAnnouncement(
  model: SidebarModel,
  snapshot: SidebarSnapshot,
): void {
  const { value: settlement } = useSubjectScopedState(
    model,
    undefined,
    () => new SidebarSettlementSentences(),
  );
  const sentences = useMemo(() => settlement.capturedFrom(snapshot), [settlement, snapshot]);
  useAnnounceOncePerSentence(sentences);
}

/**
 * What the sidebar says when its arrangement settles, or nothing.
 *
 * The refusal wins where there is one, and it is the refusal's own sentence rather than
 * a paraphrase — rule 9 renders what was refused, and the inline refusal beside this
 * carries the code.
 */
function settlementSentence(snapshot: SidebarSnapshot): string | undefined {
  const refusal = snapshot.restoreRefusals[0];
  if (refusal !== undefined) {
    return refusal.detail;
  }
  const openSectionIds = SIDEBAR_SECTION_IDS.filter(
    (sectionId) => !snapshot.state.collapsedSectionIds.has(sectionId),
  );
  if (openSectionIds.length === 0) {
    return undefined;
  }
  return `The session sidebar opened with ${openSectionIds
    .map((sectionId) => SIDEBAR_SECTION_LABELS[sectionId])
    .join(
      ", ",
    )}, ${String(SIDEBAR_SECTION_IDS.length - openSectionIds.length)} of its ${String(SIDEBAR_SECTION_IDS.length)} sections collapsed.`;
}
