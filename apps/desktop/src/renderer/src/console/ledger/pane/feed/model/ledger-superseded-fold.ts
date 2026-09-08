// The superseded fold: which of a rewound band's rows its header lets through.
//
// A THIRD PASS, AFTER THE CHAPTER FOLD AND FOR ITS REASONS. The two folds answer to
// different clocks and to different questions — a chapter is a run that ENDED, a band
// is a run of rows a rollback RANKED PAST — and running this one after the chapter's
// is what keeps both truthful: a folded chapter has already reduced itself to a
// header and a receipt, so there is nothing left in it for this pass to hide twice.
//
// AND IT INSERTS A HEADER WHERE THE MODEL ONLY HAD A BOOLEAN. `superseded-bands.ts`
// derives the band — its run, its epoch, the rewind cutoff, and every row past it —
// and until this pass the only part of that which reached a person was a dim on each
// row. Forty dimmed rows in a row said nowhere that they were one rollback, what turn
// it landed on, or how many rows it moved.
//
// THE DEFAULT IS OPEN, WHICH IS THE RULE RATHER THAN A PREFERENCE. That module states
// that a band "stays present but visibly past" and that the ledger "dims a band rather
// than deleting one, so a person can still read what was rewound away" — so this pass
// removes nothing until somebody presses a header's control, and `foldedBandKeys`
// starts empty. The individual dims are what the fold is laid OVER, never replaced by.

import { useCallback, useMemo } from "react";

import { type TimelineRow } from "@ai-sidekicks/contracts";

import { useConsoleBridge } from "../../../../bridge/index.js";
import { type LedgerViewportRow } from "../../../frame/index.js";
import { SupersededBandCollapseState } from "../../../structure/seams/index.js";
import { type SupersededBand } from "../../../structure/index.js";
import { useSessionScopedState } from "../../../../seats/index.js";
import {
  NO_ROWS_REMOVED,
  LedgerRowRetention,
  type LedgerPipelineStage,
  type LedgerWindowModel,
} from "../../window/index.js";

/**
 * Give every rewound band a header, and fold away the rows of the folded ones.
 *
 * WHY THE HEADER IS EMITTED FOR EVERY BAND rather than only for folded ones: the
 * control that opens a folded band lives on its header, so a header that appeared
 * only while folded would be the only way back and would not exist until a person
 * had already lost the rows. The chapter fold takes the same shape for the same
 * reason.
 *
 * WHY THE PASS-THROUGH ROWS KEEP THE IDENTITIES THEY ARRIVED WITH. Every viewport row
 * here was retained by the stage upstream, so re-minting one would move a key the
 * viewport's reconcile and every memo below it are holding — the exact defect
 * `LedgerRowRetention` exists to prevent. This stage retains only the identities it
 * MINTS, which are the band headers, so it holds an instance of its own and its
 * table never grows past the number of rollbacks in the window.
 *
 * A HEADER IS ITS OWN CUT UNIT AND IS PARENTED TO NOTHING, so the cap prunes it as one
 * row. Its band's members keep whatever parent the chapter fold gave them: a band
 * lives INSIDE a run, and re-parenting its rows to the band would take them out of the
 * chapter that owns them.
 */
export function foldSupersededBands(
  model: LedgerWindowModel,
  foldedBandKeys: ReadonlySet<string>,
  retention: LedgerRowRetention,
): LedgerPipelineStage {
  if (model.supersededBandByHeaderKey.size === 0) {
    return { window: model, removedRows: NO_ROWS_REMOVED };
  }
  retention.beginPass();
  const viewportRows: LedgerViewportRow[] = [];
  const rows: TimelineRow[] = [];
  const removedRows: TimelineRow[] = [];
  const rowsByKey = new Map<string, TimelineRow>();
  const headeredBandKeys = new Set<string>();
  for (const viewportRow of model.viewportRows) {
    const projected = model.rowsByKey.get(viewportRow.key);
    if (projected === undefined) {
      // A header the stage above emitted, which no projected row backs. It is not in
      // any band and passes through with the identity it arrived with.
      viewportRows.push(viewportRow);
      continue;
    }
    const bandKey = model.supersededBandKeyByRowId.get(projected.id);
    if (bandKey === undefined) {
      viewportRows.push(viewportRow);
      rows.push(projected);
      rowsByKey.set(projected.id, projected);
      continue;
    }
    if (!headeredBandKeys.has(bandKey)) {
      headeredBandKeys.add(bandKey);
      // At the band's FIRST row, so the header sits where the rewind's reach starts
      // and the log's order is untouched.
      viewportRows.push(retention.retainGroupHeaderIdentity(bandKey));
    }
    if (!foldedBandKeys.has(bandKey)) {
      viewportRows.push(viewportRow);
      rows.push(projected);
      rowsByKey.set(projected.id, projected);
      continue;
    }
    removedRows.push(projected);
  }
  return {
    window: {
      ...model,
      viewportRows,
      rows,
      rowsByKey,
      seamByRowId: new Map([...model.seamByRowId].filter(([rowId]) => rowsByKey.has(rowId))),
    },
    removedRows,
  };
}

/** What one reader has folded, and the two acts that change it. */
export interface LedgerSupersededBandDisclosure {
  /** The bands folded away behind their headers. Every other band is on screen. */
  readonly foldedBandKeys: ReadonlySet<string>;
  /** Fold an open band, or open a folded one. */
  readonly toggle: (band: SupersededBand) => void;
  /** Open the band holding this key — what a jump into a folded band calls. */
  readonly openBandKey: (bandKey: string) => void;
}

/**
 * Hold one session's superseded-band folds.
 *
 * SCOPED TO THE SESSION AND NOT TO THE MOUNT, and BOTH halves at that scope, for
 * `useChapterDisclosure`'s reason: the shell opens session stores and never closes
 * them, so this pane follows a navigation without unmounting and a mount-scoped
 * holder would carry one session's folds into the next one's rows. The instance and
 * its published mirror are one fact, so re-seeding one alone would leave the other
 * standing.
 */
export function useSupersededBandDisclosure(sessionId: string): LedgerSupersededBandDisclosure {
  const bridge = useConsoleBridge();
  const collapse = useSessionScopedState(
    bridge,
    sessionId,
    () => new SupersededBandCollapseState(),
  );
  const folded = useSessionScopedState<ReadonlySet<string>>(
    bridge,
    sessionId,
    () => new Set<string>(),
  );
  const collapseState = collapse.value;
  const publishFolded = folded.publish;
  const publish = useCallback(() => {
    publishFolded(new Set(collapseState.foldedBandKeys));
  }, [collapseState, publishFolded]);
  const toggle = useCallback(
    (band: SupersededBand) => {
      collapseState.toggle(band);
      publish();
    },
    [collapseState, publish],
  );
  const openBandKey = useCallback(
    (bandKey: string) => {
      // Only republishes where something moved: an open band asked to open again
      // would otherwise mint a fresh set and re-run every memo below this pass.
      if (collapseState.openBandKey(bandKey)) {
        publish();
      }
    },
    [collapseState, publish],
  );
  const foldedBandKeys = folded.value;
  return useMemo(
    () => ({ foldedBandKeys, toggle, openBandKey }),
    [foldedBandKeys, toggle, openBandKey],
  );
}

/**
 * Fold the bands of the window the chapter fold left.
 *
 * Its own hook rather than a second half of the chapter fold, so pressing a band's
 * control re-folds over a projection, a narrowing and a chapter fold it did not have
 * to redo — and so each fold's removed rows stay separable, which is what the find
 * field's counts are made of.
 */
export function useFoldedSupersededBands(
  model: LedgerWindowModel,
  foldedBandKeys: ReadonlySet<string>,
  sessionId: string,
): LedgerPipelineStage {
  const bridge = useConsoleBridge();
  // ITS OWN instance, never the chapter fold's: that table files a live chapter's
  // rows under no parent while the projection files them under their run, and a
  // table shared between two stages answers each with the other's triple.
  const retention = useSessionScopedState(bridge, sessionId, () => new LedgerRowRetention());
  const heldRetention = retention.value;
  return useMemo(
    () => foldSupersededBands(model, foldedBandKeys, heldRetention),
    [model, foldedBandKeys, heldRetention],
  );
}
