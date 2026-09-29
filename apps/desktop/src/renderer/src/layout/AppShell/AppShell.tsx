// The window's persistent chrome: the drawn frame, the rail's navigation, the banners
// and the command palette, around whatever screen `app/` hands it.
//
// The frame's background is inert for exactly a modal overlay's lifetime. The widget
// library's dialog traps focus and leaves inerting the app root to the shell, so this
// is where the flag is folded from its two producers: the palette, whose open state the
// window owns, and the window store's `isModalDialogOpen`, which is how a card a
// feature renders says it is up. Neither is a copy of the other.

import { useWindowStore } from "@renderer/store/window/hooks/useWindowStore.js";
import { HOST_CHORD_PLATFORM } from "@renderer/lib/chord-format.js";
import { railDestinationFor } from "@renderer/routing/route-readers.js";
import type { WindowStore } from "@renderer/store/window/window-store.js";
import { commandRegistry } from "@renderer/registries/commands/window-command-registry.js";
import type { ScreenRegistry } from "@renderer/registries/screens/screen-registry.js";
import { CommandPalette } from "../CommandPalette/CommandPalette.js";
import { describePaletteScope } from "../CommandPalette/describe-palette-scope.js";
import type { CommandPaletteProps } from "../CommandPalette/hooks/useCommandPalette.js";
import {
  RAIL_ENTRIES,
  routeForDestination,
  warmDestination,
} from "../NavigationRail/rail-navigation.js";
import { AppFrame } from "./AppFrame.js";

/** What the window hands its shell: its store, its screens, its palette, and the screen. */
export interface AppShellProps {
  readonly frameStore: WindowStore;
  /** The screen registry the window mounts through, for warming a destination on selection. */
  readonly screenRegistry: ScreenRegistry;
  /** The palette's window-owned props: its `when` context, bindings, open state and revision. */
  readonly palette: Pick<
    CommandPaletteProps,
    "context" | "bindings" | "revision" | "open" | "onOpenChange"
  >;
  /** The screen the route names. */
  readonly children: React.ReactNode;
}

/** The window's chrome around the routed screen. */
export function AppShell(props: AppShellProps): React.JSX.Element {
  const { frameStore, screenRegistry, palette } = props;
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
        frameStore.navigate(routeForDestination(destination));
      }}
      modalOverlayOpen={palette.open || isModalDialogOpen}
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
