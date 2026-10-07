// The bridge's `window` members main answers: the appearance the renderer chose, the current
// appearance record a subscription starts from, a window's minimum size, held within the work area
// of the display the window is on, a window brought forward, the widths a window with no kept
// place opens at, the end of a safe start, and the navigation request main held. Only the console
// document asks, and it names the window by the id its frame name carries. The pushes that follow
// a subscription's first delivery, and main's ask to reopen a window, come from main's registry of
// windows (`../windows/registry.ts`), which owns every window and the console document.

import { screen, type IpcMainInvokeEvent } from "electron";
import * as z from "zod/mini";

import type { AppearanceRecord } from "#shared/appearance.js";
import { BRIDGE_CHANNELS } from "#shared/bridge-channels.js";
import type { NavigationRequest } from "#shared/preload-api.js";
import type { WindowDefaultSizes, WindowSize } from "#shared/window/size.js";

import type { KeptAppearance } from "../appearance/kept-record.js";
import { appearanceChoiceSchema, appearanceGroundsSchema } from "../appearance/record-file.js";
import type { OpenWindows } from "../windows/registry.js";
import { bringWindowForward } from "../windows/reveal.js";

/** What the `window` members act on, and the window the platform's dialogs are sheeted on. */
export interface WindowHandlerContext {
  readonly appearance: Pick<KeptAppearance, "choose" | "record">;
  readonly openWindows: Pick<
    OpenWindows,
    | "windowWithId"
    | "isConsoleDocument"
    | "windowUsedLast"
    | "setDefaultSizes"
    | "endSafeStart"
    | "readNavigationRequest"
  >;
}

/** One bridge channel's answer, given the asking event and the one request it carried. */
export type ChannelAnswer = (event: IpcMainInvokeEvent, request: unknown) => unknown;

/** The channels the `window` members are answered on. */
type WindowChannel =
  | typeof BRIDGE_CHANNELS.setAppearance
  | typeof BRIDGE_CHANNELS.readAppearance
  | typeof BRIDGE_CHANNELS.readNavigationRequest
  | typeof BRIDGE_CHANNELS.setMinimumSize
  | typeof BRIDGE_CHANNELS.bringWindowForward
  | typeof BRIDGE_CHANNELS.setDefaultSizes
  | typeof BRIDGE_CHANNELS.endSafeStart;

const appearanceRequestSchema = z.strictObject({
  choice: appearanceChoiceSchema,
  grounds: appearanceGroundsSchema,
});

const windowSizeSchema: z.ZodMiniType<WindowSize> = z.strictObject({
  width: z.number().check(z.positive()),
  height: z.number().check(z.positive()),
});

const defaultSizesSchema: z.ZodMiniType<WindowDefaultSizes> = z.strictObject({
  paneWidths: z.record(z.string(), z.number().check(z.positive())),
});

const windowIdSchema = z.string();

const minimumSizeRequestSchema = z.strictObject({
  windowId: windowIdSchema,
  size: windowSizeSchema,
});

/** The `window` members' answers, by channel. Each throws on a request its schema refuses. */
export function windowAnswers(
  context: WindowHandlerContext,
): Readonly<Record<WindowChannel, ChannelAnswer>> {
  const requireConsoleDocument = (event: IpcMainInvokeEvent): void => {
    if (!context.openWindows.isConsoleDocument(event.sender)) {
      throw new Error("Only the console document asks about a window.");
    }
  };
  return {
    [BRIDGE_CHANNELS.setAppearance]: (event, request) => {
      requireConsoleDocument(event);
      const { choice, grounds } = appearanceRequestSchema.parse(request);
      return context.appearance.choose(choice, grounds);
    },
    [BRIDGE_CHANNELS.readAppearance]: (event): AppearanceRecord => {
      requireConsoleDocument(event);
      return context.appearance.record;
    },
    [BRIDGE_CHANNELS.readNavigationRequest]: (event): NavigationRequest | null => {
      requireConsoleDocument(event);
      return context.openWindows.readNavigationRequest();
    },
    [BRIDGE_CHANNELS.setMinimumSize]: (event, request) => {
      requireConsoleDocument(event);
      const { windowId, size } = minimumSizeRequestSchema.parse(request);
      const baseWindow = context.openWindows.windowWithId(windowId);
      // A window that closed while the ask crossed has no floor to hold.
      if (baseWindow === undefined) {
        return;
      }
      // A floor past the display's work area would leave the window larger than its display.
      const { workArea } = screen.getDisplayMatching(baseWindow.getBounds());
      // The platform takes whole pixels; rounding up keeps the floor from cutting a part off.
      baseWindow.setMinimumSize(
        Math.min(Math.ceil(size.width), workArea.width),
        Math.min(Math.ceil(size.height), workArea.height),
      );
    },
    [BRIDGE_CHANNELS.bringWindowForward]: (event, request) => {
      requireConsoleDocument(event);
      const baseWindow = context.openWindows.windowWithId(windowIdSchema.parse(request));
      // A window that closed while the ask crossed has nothing to bring forward; its close reaches
      // the console document on its own.
      if (baseWindow !== undefined) {
        bringWindowForward(baseWindow);
      }
    },
    [BRIDGE_CHANNELS.setDefaultSizes]: (event, request) => {
      requireConsoleDocument(event);
      context.openWindows.setDefaultSizes(defaultSizesSchema.parse(request));
    },
    [BRIDGE_CHANNELS.endSafeStart]: (event) => {
      requireConsoleDocument(event);
      context.openWindows.endSafeStart();
    },
  };
}
