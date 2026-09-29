// The window's persistent chrome: the drawn frame, the rail's navigation, the banners
// and the command palette, around whatever screen `app/` hands it.
//
// The frame's background is inert for exactly a modal overlay's lifetime. The dialog
// family traps focus and leaves inerting the app root to the shell, so this is where
// the flag is folded from its two producers: the palette, whose open state the window
// owns, and the window store's `isModalSurfaceOpen`, which is how a card a feature
// renders says it is up. Neither is a copy of the other.

import { useFrameStore } from "@renderer/console/store/shell/frame-hooks.js";
import { HOST_CHORD_PLATFORM } from "@renderer/lib/chord-format.js";
import { railDestinationFor } from "@renderer/routing/route-readers.js";
import type { FrameStore } from "@renderer/store/window/window-store.js";
import { consoleCommands } from "@renderer/registries/commands/window-command-registry.js";
import type { ConsoleSurfaceRegistry } from "@renderer/registries/screens/screen-registry.js";
import { PaletteOverlay } from "../CommandPalette/CommandPalette.js";
import { describeScope } from "../CommandPalette/describe-palette-scope.js";
import type { PaletteOverlayProps } from "../CommandPalette/hooks/useCommandPalette.js";
import {
  RAIL_ENTRIES,
  routeForDestination,
  warmDestination,
} from "../NavigationRail/rail-navigation.js";
import { AppFrame } from "./AppFrame.js";

/** What the window hands its shell: its store, its screens, its palette, and the screen. */
export interface ConsoleFrameProps {
  readonly frameStore: FrameStore;
  /** The screen registry the window mounts through, for warming a destination on selection. */
  readonly surfaceRegistry: ConsoleSurfaceRegistry;
  /** The palette's window-owned props: its `when` context, bindings, open state and revision. */
  readonly palette: Pick<
    PaletteOverlayProps,
    "context" | "bindings" | "revision" | "open" | "onOpenChange"
  >;
  /** The screen the route names. */
  readonly children: React.ReactNode;
}

/** The window's chrome around the routed screen. */
export function ConsoleFrame(props: ConsoleFrameProps): React.JSX.Element {
  const { frameStore, surfaceRegistry, palette } = props;
  const route = useFrameStore(frameStore, (state) => state.route);
  const banners = useFrameStore(frameStore, (state) => state.banners);
  // A boolean, so a window with no card up re-renders on nothing.
  const isModalSurfaceOpen = useFrameStore(frameStore, (state) => state.isModalSurfaceOpen);

  return (
    <AppFrame
      route={route}
      railEntries={RAIL_ENTRIES}
      railDestination={railDestinationFor(route)}
      onSelectDestination={(destination) => {
        // Warmed before navigating: `navigate` commits synchronously and the screen
        // mounts on the next commit, so the fetch is already in flight when it asks.
        warmDestination(surfaceRegistry, destination);
        frameStore.navigate(routeForDestination(destination));
      }}
      modalOverlayOpen={palette.open || isModalSurfaceOpen}
      banners={banners}
      onDismissBanner={(bannerId) => {
        frameStore.dismissBanner(bannerId);
      }}
      overlays={
        <PaletteOverlay
          {...palette}
          registry={consoleCommands}
          platform={HOST_CHORD_PLATFORM}
          scopeLabel={describeScope(route)}
        />
      }
    >
      {props.children}
    </AppFrame>
  );
}
