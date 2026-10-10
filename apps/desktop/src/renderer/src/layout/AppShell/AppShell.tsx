// The window's persistent chrome (rail, sessions track, banners, command palette) around the
// routed screen.
//
// The frame's background is inert while a modal overlay is up. This is where the flag is folded
// from its three producers: the boot cover, the palette's open state and the window store's
// `isModalDialogOpen`.

import { useId } from "react";

import { useWindowStore } from "#renderer/store/window/hooks/useWindowStore.js";
import { HOST_CHORD_PLATFORM } from "#renderer/lib/chord-format.js";
import { railDestinationFor } from "#renderer/routing/readers.js";
import type { LastSettingsPage } from "#renderer/store/last-settings-page.js";
import type { WindowStore } from "#renderer/store/window/store.js";
import type { WindowSize } from "#shared/window/size.js";
import { commandRegistry } from "#renderer/registries/commands/registry.js";
import type { ScreenRegistry } from "#renderer/registries/screens/registry.js";
import { CommandPalette } from "../CommandPalette/CommandPalette.js";
import { describePaletteScope } from "../CommandPalette/describe-scope.js";
import type { CommandPaletteProps } from "../CommandPalette/hooks/useCommandPalette.js";
import {
  RAIL_ENTRIES,
  RAIL_SETTINGS_ENTRY,
  routeForDestination,
  warmDestination,
} from "../NavigationRail/destinations.js";
import { RAIL_CONTROL_LABELS } from "../NavigationRail/control-labels.js";
import { SESSIONS_LIST_COMMAND } from "../NavigationRail/commands.js";
import { AppFrame } from "./AppFrame.js";
import { useRailChords } from "./hooks/useRailChords.js";

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
  /** Whether the boot cover lies over the window, which leaves the frame under it inert. */
  readonly isUnderBootCover: boolean;
  /** One line about the window itself, drawn above the banners. */
  readonly notice?: React.ReactNode;
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
  const sessionsListId = useId();
  const notificationsListId = useId();
  const railChords = useRailChords(props.readBoundChord);

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
        chords: railChords,
        sessionsList: {
          isExpanded: sessionsTrackList === "sessions",
          controlsId: sessionsListId,
          onToggle: () => {
            frameStore.toggleSessionsTrackList("sessions");
          },
        },
        // No count yet: the window mounts no attention reader, so the bell draws no pip.
        attention: {
          isExpanded: sessionsTrackList === "notifications",
          controlsId: notificationsListId,
          onToggle: () => {
            frameStore.toggleSessionsTrackList("notifications");
          },
        },
        onCycleColorScheme: props.onCycleColorScheme,
        isUpdateStaged: props.isUpdateStaged,
      }}
      sessionsTrack={
        // Each list's mount point, which its body fills.
        sessionsTrackList === "sessions" ? (
          <section id={sessionsListId} aria-label={SESSIONS_LIST_COMMAND.title} />
        ) : sessionsTrackList === "notifications" ? (
          <section id={notificationsListId} aria-label={RAIL_CONTROL_LABELS.notifications} />
        ) : undefined
      }
      modalOverlayOpen={props.isUnderBootCover || palette.open || isModalDialogOpen}
      notice={props.notice}
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
