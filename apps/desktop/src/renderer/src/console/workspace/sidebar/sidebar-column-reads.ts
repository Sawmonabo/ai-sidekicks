// What the column reads, beside what it renders.
//
// TWO HOOKS AND THE SENTENCE ONE OF THEM SPEAKS, lifted out of `Sidebar.tsx` because
// neither is about the column's markup: one folds every section's own rollup into the
// map the model decides from, and the other says once what the restored arrangement
// came back as. Keeping them here leaves that file the column and this file the reads,
// which is the same split `model/` and `persistence/` already make one level down.

import { useEffect, useMemo, useRef } from "react";

import type { ConsoleBridge } from "../../bridge/index.js";
import {
  SIDEBAR_SECTION_IDS,
  type SidebarSectionId,
  type SidebarSectionRegistry,
} from "../../seats/index.js";
import { useSessionProjectionRevision, type SessionStore } from "../../store/index.js";
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
      const context = { sessionStore, bridge };
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
  }, [sectionRegistry, sessionStore, bridge, projectionRevision]);

  useEffect(() => {
    model.syncAttention(readings.attentionBySectionId);
  }, [model, readings]);

  return readings.rollupBySectionId;
}

/**
 * Say what the sidebar came back as, once, when its saved arrangement settles.
 *
 * Not on a re-render, not when the person opens a section, and not when there is
 * nothing to report. `hasSettled` only ever goes false to true within one mount, so the
 * guard is the transition itself.
 *
 * AND ONLY WHERE THE SETTLED STATE SAYS SOMETHING THE COLUMN DOES NOT. A sidebar that
 * restored nothing and opened nothing is a sidebar a person is looking at, and
 * announcing it would spend the window's one polite lane on it — the announcer
 * serialises, so a sentence nobody needed delays the next one that somebody does.
 */
export function useSettlementAnnouncement(
  snapshot: SidebarSnapshot,
  announce: (sentence: string) => void,
): void {
  const hasAnnouncedReference = useRef(false);
  useEffect(() => {
    if (!snapshot.hasSettled || hasAnnouncedReference.current) {
      return;
    }
    hasAnnouncedReference.current = true;
    const sentence = settlementSentence(snapshot);
    if (sentence !== undefined) {
      announce(sentence);
    }
  }, [announce, snapshot]);
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
