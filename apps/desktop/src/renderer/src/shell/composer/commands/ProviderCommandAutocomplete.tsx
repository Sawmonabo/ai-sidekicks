// The discovery surface: what the bound provider offers, and what this console can do.
//
// `Spec-023 §Signature Feature Composition Sketches` §The Session Composer asks for
// "a command-and-skill autocomplete listing the target agent's own provider commands
// and skills with each entry's provider-supplied description — a DISCOVERY surface
// that shows what the bound provider offers rather than a launcher". Two consequences
// are structural here rather than conventional:
//
//   • SELECTING INSERTS NOTHING. The spec is explicit that selection "inserts nothing
//     into the message box and starts no turn", and the reason is not politeness: a
//     leading slash is refused outright on the provider-bound path, so an
//     insert-then-send affordance would compose text this shell's own send path
//     rejects. Nothing in this file writes to the line.
//   • THE ONE ACT IS THE CONSOLE'S OWN. A console command is what Spec-017's C-18
//     reserves the prefix FOR, so its row carries a button — and that button runs the
//     client-command executor, not a send. A provider row carries no button at all,
//     because there is nothing this console may do with it.
//
// THE SURFACE SPEAKS THROUGH ITS OWN STATUS REGION rather than through the window's
// live announcer. The announcer exists so a read a person did not trigger and is not
// looking at can still reach them; this popover is opened by their own keystroke and
// is where their attention already is, so speaking through the window-wide region as
// well would say everything twice.

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";

import { InlineRefusal, Nothing, WireFigure } from "../../../console/primitives/index.js";
import { type ComposerSeatProps } from "../../../console/workspace/index.js";
import { useComposerAddress } from "../composer-address.js";
import type { CommandOutcome } from "../router/command-executor.js";
import { createClientCommandExecutor } from "./client-command-executor.js";
import { composerCommandSurface, type ComposerCommandSurface } from "./console-command-surface.js";
import { useDirectiveLineDiscovery } from "./directive-line-observer.js";
import {
  composeCatalog,
  filterCatalog,
  type CommandCatalogEntry,
} from "./provider-command-catalog.js";
import { useProviderCommandEnumeration } from "./provider-command-read.js";

export type ProviderCommandAutocompleteProps = ComposerSeatProps & {
  /** The composer region whose line this surface watches. It writes to none of it. */
  readonly region: React.RefObject<HTMLElement | null>;
};

export function ProviderCommandAutocomplete(
  props: ProviderCommandAutocompleteProps,
): React.JSX.Element | null {
  const { region, bridge, route } = props;
  // The address is resolved here rather than handed down, exactly as the chip rail
  // and the send bar resolve it: one hook with three readers is one implementation,
  // and a host that passed the answer down would be a host that knew what each zone
  // was for.
  const { target } = useComposerAddress(props.sessionStore, props.focusedPane);
  const discovery = useDirectiveLineDiscovery(region);
  const isOpen = discovery.prefix !== undefined;
  const enumeration = useProviderCommandEnumeration({ bridge, target, isOpen });

  const readSurface = useCallback(() => composerCommandSurface(route), [route]);

  if (!isOpen) {
    return null;
  }
  return (
    <CommandDiscoveryPopover
      prefix={discovery.prefix ?? ""}
      readSurface={readSurface}
      enumeration={enumeration}
      stepIntoListToken={discovery.stepIntoListToken}
      onDismiss={discovery.dismiss}
    />
  );
}

interface CommandDiscoveryPopoverProps {
  readonly prefix: string;
  readonly readSurface: () => ComposerCommandSurface;
  readonly enumeration: ReturnType<typeof useProviderCommandEnumeration>;
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
function CommandDiscoveryPopover(props: CommandDiscoveryPopoverProps): React.JSX.Element {
  const { prefix, readSurface, enumeration, stepIntoListToken, onDismiss } = props;
  const listId = useId();
  const listRef = useRef<HTMLUListElement | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [actionOutcome, setActionOutcome] = useState<CommandOutcome | undefined>(undefined);

  const catalog = composeCatalog({
    offeredCommands: readSurface().offeredCommands,
    providerGroups: enumeration.phase === "served" ? enumeration.groups : [],
  });
  const entries = filterCatalog(catalog, prefix);

  const executor = useMemo(() => createClientCommandExecutor({ readSurface }), [readSurface]);

  const boundedIndex = entries.length === 0 ? -1 : Math.min(activeIndex, entries.length - 1);

  // The token at mount is the baseline, so a surface reopened after an earlier step
  // into the list does not steal focus the moment it appears.
  const stepIntoListBaselineRef = useRef(stepIntoListToken);
  useEffect(() => {
    if (stepIntoListToken > stepIntoListBaselineRef.current) {
      listRef.current?.focus();
    }
  }, [stepIntoListToken]);

  const onListKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLUListElement>) => {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActiveIndex((index) => Math.min(index + 1, entries.length - 1));
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveIndex((index) => Math.max(index - 1, 0));
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        onDismiss();
      }
    },
    [entries.length, onDismiss],
  );

  const runConsoleCommand = useCallback(
    (commandId: string) => {
      setActionOutcome(undefined);
      void executor({ commandName: commandId, text: `/${commandId}` }).then(setActionOutcome);
    },
    [executor],
  );

  return (
    <div className="meridian-command-discovery">
      <p className="meridian-command-discovery__lede">
        What this console can do, and what the addressed agent&rsquo;s provider offers. Choosing an
        entry starts no turn.
      </p>
      {entries.length === 0 ? (
        <Nothing
          kind="empty"
          placement="surface"
          title="No command matches what you have typed"
          detail="Clear the line to see everything on offer, or type // to send a message that really begins with a slash."
        />
      ) : (
        <ul
          className="meridian-command-discovery__list"
          id={listId}
          ref={listRef}
          role="listbox"
          tabIndex={0}
          aria-label="Commands and skills"
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
      <EnumerationState enumeration={enumeration} />
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

interface CatalogRowProps {
  readonly entry: CommandCatalogEntry;
  readonly rowElementId: string;
  readonly isActive: boolean;
  readonly onSelect: () => void;
  readonly onRun: (commandId: string) => void;
}

/**
 * One row: the name, what it does, and — for a console act only — the button.
 *
 * The provider row's absence of a button is the rule made visible. It is not a
 * disabled control: a disabled button asserts the act exists here and is momentarily
 * unavailable, and this console will not send a provider command from the line at
 * all.
 */
function CatalogRow(props: CatalogRowProps): React.JSX.Element {
  const { entry, rowElementId, isActive, onSelect, onRun } = props;
  return (
    <li
      className={
        isActive
          ? "meridian-command-discovery__row meridian-command-discovery__row--active"
          : "meridian-command-discovery__row"
      }
      id={rowElementId}
      role="option"
      aria-selected={isActive}
      onMouseDown={onSelect}
    >
      <span className="meridian-command-discovery__name">
        <WireFigure value={entry.name} />
      </span>
      {entry.source === "provider" ? (
        <span className="meridian-command-discovery__binding">
          {entry.kind} · <WireFigure value={entry.driverName} />
        </span>
      ) : null}
      {entry.description === undefined ? (
        <Nothing
          kind="not-checked"
          title="The provider published no description"
          detail="The entry is offered exactly as it was enumerated; nothing here supplies copy the provider did not."
        />
      ) : (
        <span className="meridian-command-discovery__description">{entry.description}</span>
      )}
      {entry.source === "console" ? (
        <button
          type="button"
          className="meridian-command-discovery__run"
          onClick={() => {
            onRun(entry.commandId);
          }}
        >
          Run this
        </button>
      ) : null}
    </li>
  );
}

/**
 * What the provider half of the list is, when it is not a list.
 *
 * Four states and four different next moves, which is why none of them is an empty
 * list: nobody was asked (this composer addresses a channel, not an agent), the read
 * is in flight, the daemon refused, or the provider answered and this is what it said.
 */
function EnumerationState(props: {
  readonly enumeration: ReturnType<typeof useProviderCommandEnumeration>;
}): React.JSX.Element | null {
  const { enumeration } = props;
  switch (enumeration.phase) {
    case "not-checked":
      return (
        <div className="meridian-command-discovery__state" role="status">
          <Nothing
            kind="not-checked"
            title="No agent is addressed, so no provider was asked"
            detail="Focus an agent's pane to see the commands and skills its bound provider publishes."
          />
        </div>
      );
    case "not-loaded":
      return (
        <div className="meridian-command-discovery__state" role="status">
          <Nothing kind="not-loaded" title="Reading the provider's commands and skills" />
        </div>
      );
    case "refused":
      return (
        <div className="meridian-command-discovery__state" role="status">
          <InlineRefusal code={enumeration.refusal.code} detail={enumeration.refusal.detail} />
        </div>
      );
    case "served":
      return null;
  }
}
