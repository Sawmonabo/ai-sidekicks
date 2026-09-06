// The popover that shows what this run's provider can be asked to do.
//
// Split from `ProviderCommandAutocomplete.tsx`, which owns the composer-side
// trigger — when a popover is open at all, and what a selection sends — while this
// owns what an open one renders and how it is moved through.
//
// EVERY ENTRY IS ONE THE PROVIDER ENUMERATED, under the binding it was read for.
// Nothing here composes a command, completes one, or offers a command the read did
// not carry.

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { InlineRefusal, Nothing } from "../../../console/primitives/index.js";
import type { CommandOutcome } from "../router/command-executor.js";
import { CatalogRow } from "./CatalogRow.js";
import { createClientCommandExecutor } from "./client-command-executor.js";
import { NO_DIRECTIVE_LINE_HANDLERS } from "./directive-line-handlers.js";
import { type ComposerCommandSurface } from "./console-command-surface.js";
import {
  composeCatalog,
  filterCatalog,
  isDeclaredUnavailable,
  selectAddressedBindingGroup,
  type AddressedProviderBinding,
} from "./provider-command-catalog.js";
import { useProviderCommandEnumeration } from "./provider-command-holder.js";
import { type ProviderCommandReadState } from "./provider-command-read.js";
import { EnumerationState } from "./EnumerationState.js";

/**
 * Why pressing a key on a provider row runs nothing.
 *
 * Declared once and rendered only in answer to the press: the popover's lede already
 * carries the standing claim ("Choosing an entry starts no turn"), which the listbox
 * names through `aria-describedby`, so this sentence exists to answer a GESTURE
 * rather than to restate the surface's purpose a second time on every open.
 */
const PROVIDER_ENTRY_NOT_RUNNABLE =
  "Provider commands and skills are listed for reference. This console starts no turn from one, so there is nothing here to run.";

/**
 * The same press, on a row the provider declared unavailable.
 *
 * Its own sentence rather than the one above, because a person who pressed this row
 * is owed the reading the reply actually carried: the entry is disabled where it
 * lives, which stays true wherever they try it next.
 */
const PROVIDER_ENTRY_DISABLED =
  "The provider published this entry as disabled, so it is unavailable there as well as here. Nothing was run.";

interface CommandDiscoveryPopoverProps {
  readonly prefix: string;
  readonly readSurface: () => ComposerCommandSurface;
  readonly enumeration: ReturnType<typeof useProviderCommandEnumeration>;
  readonly addressed: AddressedProviderBinding;
  readonly stepIntoListToken: number;
  readonly onDismiss: () => void;
}

/**
 * The popover itself, mounted only while the line opens it.
 *
 * A separate component for two reasons. The active-entry cursor is born with the
 * surface and dies with it, so a cursor held above the open state cannot survive a
 * dismissal and point at a row from a list nobody is looking at. And the catalog is
 * READ HERE, on every render this component makes, rather than memoised above it:
 * the console's command registry is filled by the frame's own registration effect
 * after a child mounts, so a list captured once would be the empty registry for the
 * life of the window.
 */
export function CommandDiscoveryPopover(props: CommandDiscoveryPopoverProps): React.JSX.Element {
  const { prefix, readSurface, enumeration, addressed, stepIntoListToken, onDismiss } = props;
  const listId = useId();
  const ledeId = `${listId}-lede`;
  const listRef = useRef<HTMLUListElement | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [actionOutcome, setActionOutcome] = useState<CommandOutcome | undefined>(undefined);
  // Set only by a press that could not be honoured, and cleared by the next move or
  // the next act, so the region never keeps answering a gesture the person has left.
  const [activationNotice, setActivationNotice] = useState<string | undefined>(undefined);

  // The addressed run's own group, selected before the catalog is composed. A served
  // reading whose groups name no binding this run is on contributes nothing, and the
  // absence says so beneath the list.
  const addressedGroup =
    enumeration.phase === "served"
      ? selectAddressedBindingGroup(enumeration.groups, addressed)
      : undefined;
  const catalog = composeCatalog({
    offeredCommands: readSurface().offeredCommands,
    providerGroups: addressedGroup === undefined ? [] : [addressedGroup],
  });
  const entries = filterCatalog(catalog, prefix);
  // A group whose tail the cap dropped answers no question about what is missing, so
  // the search over it never finished and the empty claim is withheld under it.
  const isEnumerationTruncated = addressedGroup !== undefined && !addressedGroup.complete;
  const isServedEmpty =
    entries.length === 0 && haveAllSourcesAnswered(enumeration) && !isEnumerationTruncated;

  const executor = useMemo(
    () =>
      createClientCommandExecutor({
        readSurface,
        readDirectiveHandlers: () => NO_DIRECTIVE_LINE_HANDLERS,
      }),
    [readSurface],
  );

  const boundedIndex = entries.length === 0 ? -1 : Math.min(activeIndex, entries.length - 1);

  // The token at mount is the baseline, so a surface reopened after an earlier step
  // into the list does not steal focus the moment it appears.
  const stepIntoListBaselineRef = useRef(stepIntoListToken);
  useEffect(() => {
    if (stepIntoListToken > stepIntoListBaselineRef.current) {
      listRef.current?.focus();
    }
  }, [stepIntoListToken]);

  const runConsoleCommand = useCallback(
    (commandId: string) => {
      setActionOutcome(undefined);
      setActivationNotice(undefined);
      void executor({ commandName: commandId, text: `/${commandId}` }).then(setActionOutcome);
    },
    [executor],
  );

  const onListKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLUListElement>) => {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActivationNotice(undefined);
        setActiveIndex((index) => Math.min(index + 1, entries.length - 1));
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setActivationNotice(undefined);
        setActiveIndex((index) => Math.max(index - 1, 0));
        return;
      }
      // Enter and Space settle the ACTIVE row — the row `aria-activedescendant`
      // already names, read from the same bounded index the attribute is composed
      // from, so what is announced and what is activated agree by construction
      // rather than through a second lookup that could disagree with it. Space is
      // prevented from its default before anything else happens: a listbox is a
      // focusable scroll container, and a Space that both ran the act and scrolled
      // the popover would move the list out from under the person mid-press.
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        const activeEntry = boundedIndex < 0 ? undefined : entries[boundedIndex];
        if (activeEntry === undefined) {
          return;
        }
        if (activeEntry.source === "console") {
          runConsoleCommand(activeEntry.commandId);
          return;
        }
        setActivationNotice(
          isDeclaredUnavailable(activeEntry)
            ? PROVIDER_ENTRY_DISABLED
            : PROVIDER_ENTRY_NOT_RUNNABLE,
        );
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        onDismiss();
      }
    },
    [boundedIndex, entries, onDismiss, runConsoleCommand],
  );

  return (
    <div className="meridian-command-discovery">
      <p className="meridian-command-discovery__lede" id={ledeId}>
        What this console can do, and what the addressed agent&rsquo;s provider offers. Choosing an
        entry starts no turn.
      </p>
      {entries.length === 0 ? null : (
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
          {entries.map((entry, index) => (
            <CatalogRow
              key={entry.key}
              entry={entry}
              rowElementId={rowId(listId, index)}
              isActive={index === boundedIndex}
              onSelect={() => {
                setActiveIndex(index);
              }}
              onRun={runConsoleCommand}
            />
          ))}
        </ul>
      )}
      {isServedEmpty ? (
        <Nothing
          kind="empty"
          placement="surface"
          title="No command matches what you have typed"
          detail="Clear the line to see everything on offer, or type // to send a message that really begins with a slash."
        />
      ) : null}
      {activationNotice === undefined ? null : (
        <p className="meridian-command-discovery__notice" role="status">
          {activationNotice}
        </p>
      )}
      <EnumerationState enumeration={enumeration} addressedGroup={addressedGroup} />
      {actionOutcome?.status === "refused" ? (
        <InlineRefusal code={actionOutcome.refusal.code} detail={actionOutcome.refusal.detail} />
      ) : null}
    </div>
  );
}

/**
 * The DOM id of one row, so `aria-activedescendant` names it.
 *
 * By POSITION and not by the entry's key: a key carries a provider-published name,
 * and a wire-verbatim string can hold whitespace — which an `aria-activedescendant`
 * reference cannot, because the attribute is parsed as a single id.
 */
function rowId(listId: string, index: number): string {
  return `${listId}-row-${String(index)}`;
}

/**
 * Whether every source that could hold a match has answered.
 *
 * The console's own command surface is local and always settled, so the provider
 * enumeration is the only source with phases and the only one this asks about.
 * `not-checked` counts as answered and not as pending: this composer addresses a
 * channel rather than an agent, so no provider was asked and none is coming — the
 * console's own commands are the whole of what could match, and an empty result over
 * them is a finished search. `EnumerationState` says why the provider half is absent
 * beneath it, which is a different sentence rather than a second copy of this one.
 */
function haveAllSourcesAnswered(enumeration: ProviderCommandReadState): boolean {
  return enumeration.phase === "served" || enumeration.phase === "not-checked";
}
