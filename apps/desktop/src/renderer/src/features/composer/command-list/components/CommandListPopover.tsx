// The popover listing what the console can do and what the run's provider enumerated, the
// console's commands first and then the provider's, each provider row carrying its origin mark.
// Every provider entry is one the provider enumerated for the addressed binding; nothing here
// composes or completes a provider command. `CommandList.tsx` owns when the line asks for the
// popover; the popover draws only while a row matches what is typed, because a word no row matches
// goes to the provider as typed.

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { InlineRefusal } from "#renderer/components/Refusal/InlineRefusal.js";
import { useDrawOverlayScrollbar } from "#renderer/hooks/useDrawOverlayScrollbar.js";
import type { CommandOutcome } from "../../types.js";
import { CommandListRow } from "./CommandListRow.js";
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

/** Why pressing a key on a provider row runs nothing, shown only in answer to the press. */
const PROVIDER_ENTRY_NOT_RUNNABLE =
  "Provider commands and skills are listed for reference. This app " +
  "starts no turn from one, so there is nothing here to run.";

/**
 * The popover, mounted only while the line opens it so the active-entry cursor dies with the list.
 * The catalog is read on every render, not memoized: the command registry fills after a child
 * mounts, so a list captured once would stay empty. It draws nothing while no row matches, and
 * once every source has answered with none it closes the list for the typed text, so the line's
 * own keys work again; the next edit asks afresh.
 */
export function CommandListPopover(props: CommandListPopoverProps): React.JSX.Element | null {
  const { prefix, readCommands, enumeration, addressed, stepIntoListToken } = props;
  const { onDismiss } = props;
  const listId = useId();
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
  const hasNoMatchToCome = entries.length === 0 && haveAllSourcesAnswered(enumeration);
  useEffect(() => {
    if (hasNoMatchToCome) {
      onDismiss();
    }
  }, [hasNoMatchToCome, onDismiss]);

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

  if (entries.length === 0) {
    return null;
  }
  return (
    <div className="meridian-command-discovery">
      {/* The bar is drawn inside the scroller, so the scroller is not the listbox: a listbox
          holds only its options. */}
      <div className="meridian-command-discovery__scroller" ref={scrollerScrollbarRef}>
        <ul
          className="meridian-command-discovery__list"
          id={listId}
          ref={listRef}
          role="listbox"
          tabIndex={0}
          aria-label="Commands"
          aria-activedescendant={boundedIndex < 0 ? undefined : rowId(listId, boundedIndex)}
          onKeyDown={onListKeyDown}
        >
          {entries.map((entry, index) => (
            <CommandListRow
              key={entry.key}
              entry={entry}
              rowElementId={rowId(listId, index)}
              isActive={index === boundedIndex}
              onSelect={() => {
                setActiveIndex(index);
              }}
              onActivate={() => {
                activateEntry(entry);
              }}
            />
          ))}
        </ul>
      </div>
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

/**
 * Whether every source that could hold a match has answered. `not-checked` counts as answered:
 * this composer addresses a session, so no provider was asked and none is coming.
 */
function haveAllSourcesAnswered(enumeration: ProviderCommandReadState): boolean {
  return enumeration.phase === "served" || enumeration.phase === "not-checked";
}
