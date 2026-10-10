// The popover listing what the console can do and what the run's provider enumerated.
// Every provider entry is one the provider enumerated for the addressed binding; nothing here
// composes or completes a provider command. `CommandList.tsx` owns when the popover opens.
// Two labeled groups, never one flat run: console commands are acts this window performs, provider
// entries are names it will not send. The partition keeps each row's flat position.

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { InlineRefusal } from "#renderer/components/Refusal/InlineRefusal.js";
import { Nothing } from "#renderer/components/Nothing/Nothing.js";
import { useDrawOverlayScrollbar } from "#renderer/hooks/useDrawOverlayScrollbar.js";
import type { CommandOutcome } from "../../types.js";
import { CommandListGroup, type CommandListGroupRow } from "./CommandListGroup.js";
import { createConsoleCommandExecutor } from "../console/executor.js";
import { noComposerCommandLineHandlers } from "../line-handlers.js";
import { type ComposerCommands } from "../registry-view.js";
import {
  composeCommandList,
  filterCommandList,
  isDeclaredUnavailable,
  selectAddressedBindingGroup,
  type AddressedProviderBinding,
  type CommandListEntry,
} from "../entries.js";
import { useProviderCommandEnumeration } from "../hooks/useProviderCommandEnumeration.js";
import { type ProviderCommandReadState } from "../provider/read.js";
import { EnumerationState } from "./EnumerationState.js";
import { AnnouncedLine } from "#renderer/components/AnnouncedLine/AnnouncedLine.js";

/**
 * A picked entry carries no typed argument, so an argument-reading command takes its palette
 * act.
 */
const PICKED_ENTRY_READS_NO_LINE: readonly string[] = [];

/**
 * Why pressing a key on a provider row runs nothing.
 *
 * Shown only in answer to the press: the lede already states the standing claim.
 */
const PROVIDER_ENTRY_NOT_RUNNABLE =
  "Provider commands and skills are listed for reference. This app " +
  "starts no turn from one, so there is nothing here to run.";

/** The console group's heading: it names the act, so a person knows what pressing does. */
const CONSOLE_GROUP_LABEL = "This app's commands — these run here";

/**
 * The provider group's heading. The entries are the provider's own enumeration and this console
 * starts no turn from one, so the group says so once on entering the section.
 */
const PROVIDER_GROUP_LABEL = "Discovery, not runnable";

/**
 * The popover, mounted only while the line opens it so the active-entry cursor dies with the list.
 * The catalog is read on every render, not memoized: the command registry fills after a child
 * mounts, so a list captured once would stay empty.
 */
export function CommandListPopover(props: CommandListPopoverProps): React.JSX.Element {
  const { prefix, readCommands, enumeration, addressed, stepIntoListToken } = props;
  const { onDismiss } = props;
  const listId = useId();
  const ledeId = `${listId}-lede`;
  const listRef = useRef<HTMLUListElement | null>(null);
  const scrollerScrollbarRef = useDrawOverlayScrollbar<HTMLDivElement>();
  const [activeIndex, setActiveIndex] = useState(0);
  const [actionOutcome, setActionOutcome] = useState<CommandOutcome | undefined>(undefined);
  // Set by a press that could not be honored; cleared by the next move or act.
  const [activationNotice, setActivationNotice] = useState<string | undefined>(undefined);

  // The addressed run's group, chosen before the catalog is composed; a reading with no group
  // for this run contributes nothing, and the empty state beneath the list says so.
  const addressedGroup =
    enumeration.phase === "served"
      ? selectAddressedBindingGroup(enumeration.groups, addressed)
      : undefined;
  const catalog = composeCommandList({
    runnableCommands: readCommands().runnableCommands,
    providerGroups: addressedGroup === undefined ? [] : [addressedGroup],
  });
  const entries = filterCommandList(catalog, prefix);
  const isServedEmpty = entries.length === 0 && haveAllSourcesAnswered(enumeration);

  const executor = useMemo(
    () =>
      createConsoleCommandExecutor({
        readCommands,
        readCommandLineHandlers: noComposerCommandLineHandlers,
        lineReadingCommandIds: PICKED_ENTRY_READS_NO_LINE,
      }),
    [readCommands],
  );

  // The cursor rests only on a row that can act, so the first of them takes it when the list
  // opens and the keys step over a row the provider declared disabled.
  const actableIndexes = entries.flatMap((entry, index) =>
    isDeclaredUnavailable(entry) ? [] : [index],
  );
  const boundedIndex =
    actableIndexes.find((index) => index >= activeIndex) ?? actableIndexes.at(-1) ?? -1;
  // Rows keep their flat position: the cursor, aria-activedescendant and Enter all count over
  // `entries`, so per-group numbering would light one row and activate another.
  const consoleRows = groupRowsOf(entries, "console");
  const providerRows = groupRowsOf(entries, "provider");

  // The token at mount is the baseline, so a reopened list does not steal focus on appearing.
  const stepIntoListBaselineRef = useRef(stepIntoListToken);
  useEffect(() => {
    if (stepIntoListToken > stepIntoListBaselineRef.current) {
      listRef.current?.focus();
    }
  }, [stepIntoListToken]);

  // Enter, Space and a press on a row that can act come through here: a console entry runs, a
  // provider entry is answered with why nothing ran.
  const activateEntry = useCallback(
    (entry: CommandListEntry) => {
      if (entry.source === "console") {
        setActionOutcome(undefined);
        setActivationNotice(undefined);
        void executor({ commandName: entry.commandId, text: `/${entry.commandId}` }).then(
          setActionOutcome,
        );
        return;
      }
      setActivationNotice(PROVIDER_ENTRY_NOT_RUNNABLE);
    },
    [executor],
  );

  const onListKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLUListElement>) => {
      const movedIndex = cursorMove(event.key, actableIndexes, boundedIndex);
      if (movedIndex !== undefined) {
        event.preventDefault();
        setActivationNotice(undefined);
        setActiveIndex(movedIndex);
        return;
      }
      // Enter and Space act on the row aria-activedescendant names, from the same bounded index.
      // Space is prevented because a listbox scrolls and Space would move it mid-press.
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        const activeEntry = boundedIndex < 0 ? undefined : entries[boundedIndex];
        if (activeEntry !== undefined) {
          activateEntry(activeEntry);
        }
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        onDismiss();
      }
    },
    [activateEntry, actableIndexes, boundedIndex, entries, onDismiss],
  );

  return (
    <div className="meridian-command-discovery">
      <p className="meridian-command-discovery__lede" id={ledeId}>
        What this app can do, and what the addressed sidekick&rsquo;s provider offers. Choosing an
        entry starts no turn.
      </p>
      {entries.length === 0 ? null : (
        // The bar is drawn inside the scroller, so the scroller is not the listbox: a listbox
        // holds only its groups and options.
        <div className="meridian-command-discovery__scroller" ref={scrollerScrollbarRef}>
          <ul
            className="meridian-command-discovery__list"
            id={listId}
            ref={listRef}
            role="listbox"
            tabIndex={0}
            aria-label="Commands and skills"
            aria-describedby={ledeId}
            aria-activedescendant={boundedIndex < 0 ? undefined : rowId(listId, boundedIndex)}
            onKeyDown={onListKeyDown}
          >
            {/* An empty group is left out: a heading over no rows would assert a category the
                filtered catalog does not have. */}
            {consoleRows.length === 0 ? null : (
              <CommandListGroup
                rows={consoleRows}
                labelText={CONSOLE_GROUP_LABEL}
                labelElementId={`${listId}-group-console`}
                activeFlatIndex={boundedIndex}
                rowElementId={(flatIndex) => rowId(listId, flatIndex)}
                onSelect={setActiveIndex}
                onActivate={activateEntry}
              />
            )}
            {providerRows.length === 0 ? null : (
              <CommandListGroup
                rows={providerRows}
                labelText={PROVIDER_GROUP_LABEL}
                labelElementId={`${listId}-group-provider`}
                activeFlatIndex={boundedIndex}
                rowElementId={(flatIndex) => rowId(listId, flatIndex)}
                onSelect={setActiveIndex}
                onActivate={activateEntry}
              />
            )}
          </ul>
        </div>
      )}
      {isServedEmpty ? (
        <Nothing
          kind="empty"
          placement="block"
          title="No command matches what you have typed"
          detail="Clear the line to see everything on offer."
        />
      ) : null}
      {activationNotice === undefined ? null : (
        <AnnouncedLine
          element="p"
          className="meridian-command-discovery__notice"
          words={activationNotice}
          politeness="polite"
        />
      )}
      <EnumerationState enumeration={enumeration} addressedGroup={addressedGroup} />
      {actionOutcome?.status === "refused" ? (
        <InlineRefusal code={actionOutcome.refusal.code} detail={actionOutcome.refusal.detail} />
      ) : null}
    </div>
  );
}

interface CommandListPopoverProps {
  readonly prefix: string;
  readonly readCommands: () => ComposerCommands;
  readonly enumeration: ReturnType<typeof useProviderCommandEnumeration>;
  readonly addressed: AddressedProviderBinding;
  readonly stepIntoListToken: number;
  readonly onDismiss: () => void;
}

/**
 * The DOM id of one row, by position rather than entry key: a provider-published name can hold
 * whitespace, which an aria-activedescendant id reference cannot.
 */
function rowId(listId: string, index: number): string {
  return `${listId}-row-${String(index)}`;
}

/**
 * Where a cursor key moves the cursor among the rows that can act: the arrows one row, Home and
 * End to the first and last. `undefined` for any other key, or while no row can act.
 */
function cursorMove(
  key: string,
  actableIndexes: readonly number[],
  activeIndex: number,
): number | undefined {
  const position = actableIndexes.indexOf(activeIndex);
  if (position < 0) {
    return undefined;
  }
  switch (key) {
    case "ArrowDown":
      return actableIndexes[Math.min(position + 1, actableIndexes.length - 1)];
    case "ArrowUp":
      return actableIndexes[Math.max(position - 1, 0)];
    case "Home":
      return actableIndexes[0];
    case "End":
      return actableIndexes.at(-1);
    default:
      return undefined;
  }
}

/** One group's rows, each keeping its position in the flat sequence; catalog order is kept. */
function groupRowsOf(
  entries: readonly CommandListEntry[],
  source: CommandListEntry["source"],
): readonly CommandListGroupRow[] {
  const rows: CommandListGroupRow[] = [];
  entries.forEach((entry, flatIndex) => {
    if (entry.source === source) {
      rows.push({ entry, flatIndex });
    }
  });
  return rows;
}

/**
 * Whether every source that could hold a match has answered. `not-checked` counts as answered:
 * this composer addresses a session, so no provider was asked and none is coming.
 */
function haveAllSourcesAnswered(enumeration: ProviderCommandReadState): boolean {
  return enumeration.phase === "served" || enumeration.phase === "not-checked";
}
