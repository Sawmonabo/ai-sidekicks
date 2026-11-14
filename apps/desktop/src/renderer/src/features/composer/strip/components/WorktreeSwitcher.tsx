// The worktree chip and its popover: the repo root row, a rule, one row per tree with its base,
// ahead, behind and uncommitted figures and who occupies it, a trash on a tree the app made, a
// rule, and `Details`. Picking a row moves the session there, at once when idle or when the run
// ends, and a refused move is said on the row pressed; a removal confirms in the row's place and
// leaves `<name> removed · Put back` behind.

import { Popover } from "@base-ui/react/popover";
import { useState } from "react";

import type { ProjectListEntry } from "@ai-sidekicks/contracts/project";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import type {
  RemovedWorktreeId,
  WorktreeId,
  WorktreeStatusReadResponse,
} from "@ai-sidekicks/contracts/worktree/lifecycle";

import { ChordHint } from "#renderer/components/ChordHint/ChordHint.js";
import { Glyph } from "#renderer/components/Glyph/Glyph.js";
import { HoverLabel } from "#renderer/components/HoverLabel/HoverLabel.js";
import { InlineRefusal } from "#renderer/components/Refusal/InlineRefusal.js";
import { LoadingNotice } from "#renderer/components/LoadingNotice/LoadingNotice.js";
import { OverlayPopoverPopup } from "#renderer/components/OverlayPopups/OverlayPopoverPopup.js";
import { TryAgainButton } from "#renderer/components/TryAgainButton/TryAgainButton.js";
import { formatZonedDateTime } from "#renderer/lib/wire/figures.js";
import type { ExtendedRefusal } from "#renderer/lib/refusal/extensions.js";
import { callDaemon } from "#renderer/services/daemon/reply.js";
import type { PlatformBridge } from "#renderer/services/platform/bridge.js";
import { useClock } from "#renderer/services/platform/hooks/useClock.js";
import { useClockLocale } from "#renderer/services/platform/hooks/useClockLocale.js";
import {
  useHeldWorktreeMove,
  type MoveTarget,
  type PickedRow,
} from "../hooks/useHeldWorktreeMove.js";
import { moveRefusalWords, type MovedTree } from "../move-refusal.js";
import { NewWorktreeForm } from "./NewWorktreeForm.js";
import { readWorktreeRow, type WorktreeRow } from "../worktrees.js";

/** What the switcher reads and moves: the session, its project, and where the session works now. */
export interface WorktreeSwitcherProps {
  readonly bridge: PlatformBridge;
  readonly sessionId: SessionId;
  /** The session's project, whose own checkout the root row moves to before the list is read. */
  readonly project: ProjectListEntry;
  /** The name the chip reads: the tree the session works in now. */
  readonly currentName: string;
  /** The session name a busy tree's reason names, by session id. */
  readonly sessionNameOf: (sessionId: string) => string;
  /** Open the inspector on the session's tree. */
  readonly openDetails: () => void;
}

/** The worktree chip, opening its popover. */
export function WorktreeSwitcher(props: WorktreeSwitcherProps): React.JSX.Element {
  const clock = useClock();
  const clockLocale = useClockLocale();
  const [isOpen, setIsOpen] = useState(false);
  const [standIn, setStandIn] = useState<RowStandIn | undefined>(undefined);
  const [isMakingNew, setIsMakingNew] = useState(false);
  const [refusal, setRefusal] = useState<ExtendedRefusal | undefined>(undefined);
  const [moveRefusal, setMoveRefusal] = useState<MoveRefusal | undefined>(undefined);
  const { pending, holdMove, reading, readAgain } = useHeldWorktreeMove(
    props.bridge,
    props.project.projectId,
    props.sessionId,
    isOpen,
    props.currentName,
  );
  // `row` is the row pressed, where a refusal is said; `target` is the picked tree, or `undefined`
  // for a cancel, which leaves no move.
  const moveTo = (row: PickedRow, tree: MovedTree, target: MoveTarget | undefined): void => {
    const fromName = props.currentName;
    void callDaemon(props.bridge, "session.workingFolder.update", {
      sessionId: props.sessionId,
      path: tree.path,
    }).then((reply) => {
      if (reply.status === "refused") {
        const words = moveRefusalWords(reply.refusal, tree);
        setMoveRefusal({ row, refusal: reply.refusal, words });
        return;
      }
      setMoveRefusal(undefined);
      holdMove(
        reply.value.disposition === "pending" && target !== undefined
          ? { name: target.name, branchName: target.branchName, row, fromName }
          : undefined,
      );
    });
  };
  const remove = (worktreeId: WorktreeId, path: string, discard: boolean): void => {
    void callDaemon(props.bridge, "worktree.retire", { worktreeId, discard }).then((reply) => {
      if (reply.status === "served") {
        setStandIn({ kind: "removed", path, kept: reply.value.kept?.removedWorktreeId });
        return;
      }
      if (reply.refusal.reason === "hasChanges") {
        // The tree changed since its figures were read: read them again and confirm again.
        setStandIn({ kind: "confirming", path, hasChanges: true });
        readAgain();
        return;
      }
      setRefusal(reply.refusal);
    });
  };
  const putBack = (removedWorktreeId: RemovedWorktreeId): void => {
    void callDaemon(props.bridge, "worktree.restore", { removedWorktreeId }).then((reply) => {
      if (reply.status === "refused") {
        setRefusal(reply.refusal);
        return;
      }
      setStandIn(undefined);
      readAgain();
    });
  };
  const rootTarget: MoveTarget =
    reading.kind === "loaded"
      ? { name: reading.status.repoRoot.branchName, branchName: reading.status.repoRoot.branchName }
      : { name: props.project.name, branchName: undefined };
  // What a row says after its pick: the held move with its `Cancel`, then a refused move.
  const pickLines = (row: PickedRow): React.JSX.Element => (
    <>
      {pending !== undefined && isSameRow(pending.row, row) && reading.kind === "loaded" ? (
        <span className="meridian-composer-worktrees__faint">
          switching when this run ends{" "}
          <button
            type="button"
            className="meridian-clickable-word"
            onClick={() => {
              // Re-targeting the tree the session works in now cancels the move.
              moveTo(row, currentTreeIn(reading.status, props.sessionId), undefined);
            }}
          >
            Cancel
          </button>
        </span>
      ) : null}
      {moveRefusal !== undefined && isSameRow(moveRefusal.row, row) ? (
        <InlineRefusal
          code={moveRefusal.refusal.code}
          detail={moveRefusal.words}
          attempt={moveRefusal.refusal}
        />
      ) : null}
    </>
  );
  const chipWords =
    pending === undefined
      ? props.currentName
      : `${props.currentName} → ${pending.name} when this run ends`;
  // A refused move's line stays on its row, and stands in for it once a later read drops the tree.
  const unlistedRefusalRow =
    moveRefusal !== undefined && reading.kind === "loaded"
      ? unlistedRow(moveRefusal.row, reading.status)
      : undefined;
  const rootPath =
    reading.kind === "loaded" ? reading.status.repoRoot.path : props.project.folderPath;
  return (
    <Popover.Root
      open={isOpen}
      onOpenChange={(open) => {
        setIsOpen(open);
        if (!open) {
          setStandIn(undefined);
          setIsMakingNew(false);
          setRefusal(undefined);
          setMoveRefusal(undefined);
        }
      }}
    >
      <Popover.Trigger className="meridian-composer-chip">
        <Glyph name="worktree" />
        {chipWords}
      </Popover.Trigger>
      <OverlayPopoverPopup className="meridian-composer-worktrees" sideOffset={4}>
        {/* Drawn at once from the project; the read names the checkout's branch once it lands. */}
        <div className="meridian-composer-worktrees__row">
          <button
            type="button"
            className="meridian-composer-worktrees__pick"
            onClick={() => {
              moveTo(ROOT_ROW, { path: rootPath, name: rootTarget.name }, rootTarget);
            }}
          >
            {rootTarget.name}
          </button>
          {pickLines(ROOT_ROW)}
        </div>
        {isMakingNew && reading.kind === "loaded" && reading.status.newWorktree !== undefined ? (
          <NewWorktreeForm
            bridge={props.bridge}
            sessionId={props.sessionId}
            suggestion={reading.status.newWorktree}
            isSourceDirty={isSourceDirty(reading.status, props.sessionId)}
            onCancel={() => {
              setIsMakingNew(false);
            }}
            onCreated={() => {
              setIsMakingNew(false);
              setIsOpen(false);
            }}
          />
        ) : (
          <button
            type="button"
            className="meridian-composer-worktrees__row"
            onClick={() => {
              setIsMakingNew(true);
            }}
          >
            New worktree…
          </button>
        )}
        <div role="separator" className="meridian-composer-worktrees__rule" />
        {reading.kind === "loading" ? (
          <LoadingNotice title="Loading…" placement="block" clock={clock} />
        ) : null}
        {reading.kind === "failed" ? (
          <p className="meridian-composer-worktrees__failed">
            Couldn't load worktrees <TryAgainButton onPress={readAgain} />
          </p>
        ) : null}
        {reading.kind === "loaded" ? (
          <ul className="meridian-composer-worktrees__list">
            {reading.status.worktrees.map((record) => {
              const row = readWorktreeRow(record);
              if (standIn?.path === row.path && standIn.kind === "removed") {
                return (
                  <li key={row.path} className="meridian-composer-worktrees__row">
                    {`${row.name} removed`}
                    {standIn.kept === undefined ? null : (
                      <>
                        {" · "}
                        <button
                          type="button"
                          className="meridian-clickable-word"
                          onClick={() => {
                            if (standIn.kept !== undefined) {
                              putBack(standIn.kept);
                            }
                          }}
                        >
                          Put back
                        </button>
                      </>
                    )}
                  </li>
                );
              }
              if (
                standIn?.kind === "confirming" &&
                standIn.path === row.path &&
                row.removableWorktreeId !== undefined
              ) {
                const worktreeId = row.removableWorktreeId;
                const discards = standIn.hasChanges || removalRisks(row) !== undefined;
                return (
                  <li key={row.path} className="meridian-composer-worktrees__confirm">
                    <span>
                      {discards
                        ? `${removalRisks(row) ?? ""} A copy is kept until you delete it.`.trim()
                        : "Clean and unused."}
                    </span>
                    <button
                      type="button"
                      className="meridian-clickable-word"
                      onClick={() => {
                        setStandIn(undefined);
                      }}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      className="meridian-clickable-word"
                      onClick={() => {
                        remove(worktreeId, row.path, discards);
                      }}
                    >
                      {discards ? "Discard and remove" : "Remove"}
                    </button>
                  </li>
                );
              }
              return (
                <li key={row.path} className="meridian-composer-worktrees__row">
                  <button
                    type="button"
                    className="meridian-composer-worktrees__pick"
                    onClick={() => {
                      moveTo({ kind: "worktree", path: row.path }, row, row);
                    }}
                  >
                    <span>{row.name}</span>
                    {row.offBase === undefined ? null : (
                      <span className="meridian-composer-worktrees__faint">{row.offBase}</span>
                    )}
                    <span className="meridian-composer-worktrees__figures">
                      {row.ahead === undefined ? null : <span>{row.ahead}</span>}
                      {row.behind === undefined ? null : <span>{row.behind}</span>}
                      {reading.status.countsAsOf === undefined ? null : (
                        <span className="meridian-composer-worktrees__faint">
                          Last updated {formatZonedDateTime(reading.status.countsAsOf, clockLocale)}
                        </span>
                      )}
                      {row.uncommitted === undefined ? null : (
                        <span className="meridian-composer-worktrees__dirty">
                          {row.uncommitted}
                        </span>
                      )}
                      {row.occupyingSessionIds.length === 0 ? null : (
                        <span className="meridian-composer-worktrees__faint">
                          {occupancyCount(row)}
                        </span>
                      )}
                    </span>
                  </button>
                  {pickLines({ kind: "worktree", path: row.path })}
                  {row.removableWorktreeId === undefined ? null : (
                    <HoverLabel
                      text={
                        row.runningSessionId === undefined
                          ? "Remove"
                          : `Busy: ${props.sessionNameOf(row.runningSessionId)} is running in it.`
                      }
                      textRole="description"
                    >
                      <button
                        type="button"
                        className="meridian-composer-worktrees__trash"
                        aria-label={`Remove ${row.name}`}
                        aria-disabled={row.runningSessionId === undefined ? undefined : "true"}
                        onClick={() => {
                          if (row.runningSessionId === undefined) {
                            setStandIn({ kind: "confirming", path: row.path, hasChanges: false });
                          }
                        }}
                      >
                        <Glyph name="close" />
                      </button>
                    </HoverLabel>
                  )}
                </li>
              );
            })}
            {unlistedRefusalRow === undefined ? null : (
              <li className="meridian-composer-worktrees__row">{pickLines(unlistedRefusalRow)}</li>
            )}
          </ul>
        ) : null}
        {refusal === undefined ? null : (
          <InlineRefusal code={refusal.code} detail={refusal.detail} />
        )}
        <div role="separator" className="meridian-composer-worktrees__rule" />
        <button
          type="button"
          className="meridian-composer-worktrees__row"
          onClick={() => {
            setIsOpen(false);
            props.openDetails();
          }}
        >
          Details <ChordHint chord="$mod+KeyI" />
        </button>
      </OverlayPopoverPopup>
    </Popover.Root>
  );
}

const ROOT_ROW: PickedRow = { kind: "root" };

/** A move the daemon refused: the row it was pressed on, the refusal, and the words it reads. */
interface MoveRefusal {
  readonly row: PickedRow;
  readonly refusal: ExtendedRefusal;
  readonly words: string;
}

/** `row` when it names a tree `status` does not list, else `undefined`. */
function unlistedRow(row: PickedRow, status: WorktreeStatusReadResponse): PickedRow | undefined {
  const path = row.kind === "worktree" ? row.path : undefined;
  return path !== undefined && !status.worktrees.some((record) => record.path === path)
    ? row
    : undefined;
}

function isSameRow(picked: PickedRow, row: PickedRow): boolean {
  return picked.kind === "root" || row.kind === "root"
    ? picked.kind === row.kind
    : picked.path === row.path;
}

/** A row standing in for its tree while its removal is confirmed, or after it went. */
type RowStandIn =
  | { readonly kind: "confirming"; readonly path: string; readonly hasChanges: boolean }
  | {
      readonly kind: "removed";
      readonly path: string;
      readonly kept: RemovedWorktreeId | undefined;
    };

/** The confirm's risk line from what the row shows, or `undefined` for a clean, unused tree. */
function removalRisks(row: WorktreeRow): string | undefined {
  const risks = [
    countWords(row.uncommittedFileCount, "uncommitted file", "uncommitted files"),
    countWords(row.unpushedCommitCount, "unpushed commit", "unpushed commits"),
    occupancyCount(row),
  ].filter((risk) => risk !== undefined);
  return risks.length === 0 ? undefined : `${risks.join(" · ")}.`;
}

/** The occupancy phrase, `1 session attached` or `2 sessions attached`, absent with none. */
function occupancyCount(row: WorktreeRow): string | undefined {
  return countWords(row.occupyingSessionIds.length, "session attached", "sessions attached");
}

/** `<count> <noun>` in the noun's number, absent at zero. */
function countWords(count: number, singular: string, plural: string): string | undefined {
  return count === 0 ? undefined : `${String(count)} ${count === 1 ? singular : plural}`;
}

/** The tree `sessionId` works in now: the one it occupies, else the project's own checkout. */
function currentTreeIn(status: WorktreeStatusReadResponse, sessionId: SessionId): MovedTree {
  const occupied = status.worktrees.find((record) =>
    record.occupyingSessionIds.includes(sessionId),
  );
  return occupied === undefined
    ? { path: status.repoRoot.path, name: status.repoRoot.branchName }
    : { path: occupied.path, name: occupied.name };
}

/** Whether the tree `sessionId` works in holds uncommitted changes a new tree could carry. */
function isSourceDirty(status: WorktreeStatusReadResponse, sessionId: SessionId): boolean {
  const current = status.worktrees.find((record) => record.occupyingSessionIds.includes(sessionId));
  return current !== undefined && current.uncommittedFileCount > 0;
}
