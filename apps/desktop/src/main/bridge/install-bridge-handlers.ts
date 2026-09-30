// Every channel answers only a console document: the asking frame must be on an origin a
// console window may navigate within. Any other frame is refused before its request is read.

import path from "node:path";

import { BrowserWindow, clipboard, dialog, ipcMain, type IpcMainInvokeEvent } from "electron";

import { BRIDGE_CHANNELS } from "@shared/bridge-channels.js";
import type { OpenDialogPurpose, OpenDialogResults } from "@shared/preload-api.js";
import { classifyNavigation, inWindowOrigins, openExternalUrl } from "../windows/navigation.js";
import { FilePathRefs } from "./file-path-refs.js";
import { KEYBOARD_MAP_FILE_NAME, KeyboardMapFile, parseKeyboardMap } from "./keyboard-map-file.js";
import { copyToClipboard, showOpenDialog } from "./native-handlers.js";

/** Where main keeps its own files. */
export interface BridgeHandlerPaths {
  readonly userData: string;
}

/** Register every bridge member main answers. Called once, after ready, before any window. */
export function installBridgeHandlers(paths: BridgeHandlerPaths): void {
  const filePathRefs = new FilePathRefs();
  const keyboardMapFile = new KeyboardMapFile({
    filePath: path.join(paths.userData, KEYBOARD_MAP_FILE_NAME),
    now: () => new Date(),
  });

  handleFromConsole(
    BRIDGE_CHANNELS.showOpenDialog,
    (event, options): Promise<OpenDialogResults[OpenDialogPurpose]> =>
      showOpenDialog(
        {
          showOpenDialog: (dialogOptions) => {
            const owner = BrowserWindow.fromWebContents(event.sender);
            return owner === null
              ? dialog.showOpenDialog(dialogOptions)
              : dialog.showOpenDialog(owner, dialogOptions);
          },
        },
        filePathRefs,
        event.sender,
        options,
      ),
  );
  handleFromConsole(BRIDGE_CHANNELS.openExternal, (_event, url) => {
    if (typeof url !== "string") {
      throw new TypeError("An outside address is a string.");
    }
    return openExternalUrl(url);
  });
  handleFromConsole(BRIDGE_CHANNELS.copyToClipboard, (_event, text) => {
    copyToClipboard(clipboard, text);
  });
  handleFromConsole(BRIDGE_CHANNELS.readKeyboardMap, () => keyboardMapFile.read());
  handleFromConsole(BRIDGE_CHANNELS.writeKeyboardMap, (_event, map) =>
    keyboardMapFile.write(parseKeyboardMap(map)),
  );
}

/**
 * Whether the frame that sent a request is a console document. A frame that has navigated
 * away or been torn down has no URL to judge and is refused with the rest.
 */
function isConsoleFrame(event: IpcMainInvokeEvent): boolean {
  const frameUrl = event.senderFrame?.url;
  return (
    frameUrl !== undefined && classifyNavigation(frameUrl, inWindowOrigins()).kind === "in-window"
  );
}

function handleFromConsole(
  channel: string,
  answer: (event: IpcMainInvokeEvent, request: unknown) => unknown,
): void {
  ipcMain.handle(channel, (event, request: unknown) => {
    if (!isConsoleFrame(event)) {
      throw new Error(`${channel} answers only a console document.`);
    }
    return answer(event, request);
  });
}
