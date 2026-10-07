// The window's persistent chrome (rail, banners, command palette) around the routed screen.
//
// The frame's background is inert while a modal overlay is up. This is where the flag is folded
// from its two producers: the palette's open state and the window store's `isModalDialogOpen`.

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
  routeForDestination,
  warmDestination,
} from "../NavigationRail/destinations.js";
import { AppFrame } from "./AppFrame.js";

/** What the window hands `AppShell`: its store, its screens, its palette, and the screen. */
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

  return (
    <AppFrame
      route={route}
      railEntries={RAIL_ENTRIES}
      railDestination={railDestinationFor(route)}
      onSelectDestination={(destination) => {
        // Warmed before navigating: `navigate` commits synchronously and the screen
        // mounts on the next commit, so the fetch is already in flight when it asks.
        warmDestination(screenRegistry, destination);
        frameStore.navigate(routeForDestination(destination, lastSettingsPage.pageId));
      }}
      modalOverlayOpen={palette.open || isModalDialogOpen}
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
