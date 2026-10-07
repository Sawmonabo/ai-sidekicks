// The window's persistent chrome (rail, sessions track, banners, command palette) around the
// routed screen.
//
// The frame's background is inert while a modal overlay is up. This is where the flag is folded
// from its two producers: the palette's open state and the window store's `isModalDialogOpen`.

import { useId } from "react";

import { useWindowStore } from "#renderer/store/window/hooks/useWindowStore.js";
import { HOST_CHORD_PLATFORM, formatChordForPlatform } from "#renderer/lib/chord-format.js";
import { railDestinationFor, type RailDestination } from "#renderer/routing/readers.js";
import type { LastSettingsPage } from "#renderer/store/last-settings-page.js";
import type { WindowStore } from "#renderer/store/window/store.js";
import type { WindowSize } from "#shared/window/size.js";
import { commandRegistry } from "#renderer/registries/commands/registry.js";
import type { ScreenRegistry } from "#renderer/registries/screens/registry.js";
import { CommandPalette } from "../CommandPalette/CommandPalette.js";
import { describePaletteScope } from "../CommandPalette/describe-scope.js";
import type { CommandPaletteProps } from "../CommandPalette/hooks/useCommandPalette.js";
import { RAIL_NAVIGATION_DETAILS } from "../NavigationRail/commands.js";
import {
  RAIL_ENTRIES,
  RAIL_SETTINGS_ENTRY,
  routeForDestination,
  warmDestination,
} from "../NavigationRail/destinations.js";
import { RAIL_CONTROL_LABELS } from "../NavigationRail/NavigationRail.js";
import { AppFrame } from "./AppFrame.js";

/** What the window hands `AppShell`: its store, screens, palette and chords, and the screen. */
export interface AppShellProps {
  readonly frameStore: WindowStore;
  /** The screen registry the window mounts through, for warming a destination on selection. */
  readonly screenRegistry: ScreenRegistry;
  /** The settings page last open, which the rail's Settings opens again. */
  readonly lastSettingsPage: LastSettingsPage;
  /**
   * The palette's window-owned props: its `when` context, bindings, open state and revision.
   */
  readonly palette: Pick<
    CommandPaletteProps,
    "context" | "bindings" | "revision" | "open" | "onOpenChange"
  >;
  /** The chord a command holds now, or `undefined` while it holds none. */
  readonly readBoundChord: (commandId: string) => string | undefined;
  /** Steps this window's color scheme to the next in its cycle. */
  readonly onCycleColorScheme: () => void;
  /** Whether an update is staged and waiting for the restart. */
  readonly isUpdateStaged: boolean;
  /** One line about the window itself, drawn above the banners. */
  readonly notice?: React.ReactNode;
  /** The narrowest one pane may be, in CSS px, the pane term of the window's floor. */
  readonly minimumPaneWidthPx: number;
  /** The window's smallest size, in CSS px, reported on first layout and on every change. */
  readonly onWindowFloorChange: (floor: WindowSize) => void;
  /** The screen the route names. */
  readonly children: React.ReactNode;
}

/** The window's chrome around the routed screen. */
export function AppShell(props: AppShellProps): React.JSX.Element {
  const { frameStore, screenRegistry, palette, lastSettingsPage } = props;
  const route = useWindowStore(frameStore, (state) => state.route);
  const banners = useWindowStore(frameStore, (state) => state.banners);
  // A boolean, so a window with no card up re-renders on nothing.
  const isModalDialogOpen = useWindowStore(frameStore, (state) => state.isModalDialogOpen);
  const sessionsTrackList = useWindowStore(frameStore, (state) => state.sessionsTrackList);
  const notificationsListId = useId();
  const isNotificationsListOpen = sessionsTrackList === "notifications";

  return (
    <AppFrame
      route={route}
      rail={{
        entries: RAIL_ENTRIES,
        settingsEntry: RAIL_SETTINGS_ENTRY,
        current: railDestinationFor(route),
        onSelect: (destination) => {
          // Warmed before navigating: `navigate` commits synchronously and the screen
          // mounts on the next commit, so the fetch is already in flight when it asks.
          warmDestination(screenRegistry, destination);
          frameStore.navigate(routeForDestination(destination, lastSettingsPage.pageId));
        },
        chords: railChords(props.readBoundChord),
        // No count yet: the window mounts no attention reader, so the bell draws no pip.
        attention: {
          isExpanded: isNotificationsListOpen,
          controlsId: notificationsListId,
          onToggle: () => {
            frameStore.toggleNotificationsList();
          },
        },
        onCycleColorScheme: props.onCycleColorScheme,
        isUpdateStaged: props.isUpdateStaged,
      }}
      sessionsTrack={
        isNotificationsListOpen ? (
          // The notifications list's mount point, which its body fills.
          <section id={notificationsListId} aria-label={RAIL_CONTROL_LABELS.notifications} />
        ) : undefined
      }
      modalOverlayOpen={palette.open || isModalDialogOpen}
      notice={props.notice}
      minimumPaneWidthPx={props.minimumPaneWidthPx}
      onWindowFloorChange={props.onWindowFloorChange}
      banners={banners}
      onDismissBanner={(bannerId) => {
        frameStore.dismissBanner(bannerId);
      }}
      overlays={
        <CommandPalette
          {...palette}
          registry={commandRegistry}
          platform={HOST_CHORD_PLATFORM}
          scopeLabel={describePaletteScope(route)}
        />
      }
    >
      {props.children}
    </AppFrame>
  );
}

// Sessions is the one rail button that advertises its chord, read fresh on every draw so a
// rebinding changes the hint.
function railChords(
  readBoundChord: (commandId: string) => string | undefined,
): Partial<Record<RailDestination, string>> {
  const chord = readBoundChord(RAIL_NAVIGATION_DETAILS.sessions.commandId);
  return chord === undefined
    ? {}
    : { sessions: formatChordForPlatform(chord, HOST_CHORD_PLATFORM) };
}
