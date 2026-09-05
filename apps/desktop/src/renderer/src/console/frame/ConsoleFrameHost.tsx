// The bridge gate, and the token sheet that has to be on the document above it.
//
//   • **Tokens before paint, and ABOVE the bridge gate.** The sheet is installed in
//     a layout effect, which runs before the browser paints, so no frame renders
//     against an unstyled cascade. It is installed HERE rather than by the frame
//     under it, because this component has a state the frame never reaches: a
//     window whose preload never ran renders the missing-bridge card and mounts no
//     frame at all. Installed one level down, that exact recovery state — the one a
//     person is most likely to be reading when something has gone wrong — came up
//     in browser defaults, without the custom properties or the full-height rules
//     the card is laid out against. One installer, one call site; the failure
//     branch gets no copy of its own.
//   • **The failure arm is a component boundary rather than an `if` further down.**
//     Everything below this holds a resolved `ConsoleBridge` by construction, which
//     is what lets the frame's own command surface contribute the palette's
//     bridge-backed acts: those are built by a hook that throws when the bridge is
//     unavailable — correctly, since a component reaching for a missing bridge is a
//     wiring bug — and a hook cannot be called conditionally.
//
// The resolution is decided once per provider and does not change afterwards, so
// this boundary never remounts the frame under a running window.

import { useLayoutEffect, type ReactNode } from "react";

import { useBridgeResolution } from "../bridge/index.js";
import { Nothing } from "../primitives/index.js";
import { ConsoleFrame } from "./ConsoleFrame.js";
import { type ConsoleSurfaceContext } from "./surface-registry.js";
import { installMeridianTokens } from "./token-installation.js";

export interface ConsoleFrameHostProps {
  readonly renderOverlays?: (context: ConsoleSurfaceContext) => ReactNode;
}

export function ConsoleFrameHost(props: ConsoleFrameHostProps): React.JSX.Element {
  useMeridianTokenSheet();
  const resolution = useBridgeResolution();
  if (resolution.status === "unavailable") {
    return (
      <div className="meridian-frame meridian-frame--bare">
        <Nothing
          kind="error"
          title="This window cannot reach the app."
          detail={resolution.unavailable.detail}
        />
      </div>
    );
  }
  return (
    <ConsoleFrame
      bridge={resolution.bridge}
      {...(props.renderOverlays === undefined ? {} : { renderOverlays: props.renderOverlays })}
    />
  );
}

/**
 * Put the Meridian token sheet on the document, before the first paint.
 *
 * A hook rather than a call in a render body: installing it is a document
 * mutation, and a layout effect is the one place a mutation runs after React has
 * committed and before the browser paints. `installMeridianTokens` is idempotent
 * by element id, so a second window — or a hot reload — re-enters this and writes
 * nothing.
 *
 * The scheme ATTRIBUTE deliberately does not ride here. It is a projection of a
 * preference read back from the durable store, which only a window with a bridge
 * has; and `applyConsoleScheme` writes the attribute for an explicit choice and
 * REMOVES it for `"system"`, so applying a default here would be a no-op on the
 * one arm this hoist exists for and a clobber of the frame's own value on the
 * other — React runs a child's layout effect before its parent's, so the parent
 * would win. A window with no bridge renders under no attribute, which is the
 * sheet's `prefers-color-scheme` layer deciding: correct in both schemes.
 */
function useMeridianTokenSheet(): void {
  useLayoutEffect(() => {
    installMeridianTokens(document);
  }, []);
}
