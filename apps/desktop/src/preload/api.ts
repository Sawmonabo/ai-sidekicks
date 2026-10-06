// The object the preload exposes: every member carried over IPC, beside the build facts main
// passed at start.

import { ipcRenderer, webUtils } from "electron";

import { readAppFactsSwitches } from "#shared/app-facts.js";
import { BRIDGE_CHANNELS } from "#shared/bridge-channels.js";
import { readLastUsedWindowIdSwitch } from "#shared/window/last-used.js";
import {
  type EditorEntry,
  type FilePathRef,
  type KeyboardMap,
  type KeyboardMapReading,
  type NotificationPermission,
  type OpenDialogOptions,
  type OpenDialogPurpose,
  type OpenDialogResults,
  type PreloadApi,
} from "#shared/preload-api.js";
import { createDaemonWire, DaemonSubscriptions } from "./daemon.js";
import { createMachineSettingsBridge } from "./machine-settings.js";
import { createUpdateBridge } from "./update.js";
import { createWindowBridge } from "./window.js";

/** The bridge object `index.ts` exposes on `window.desktopBridge`. */
export function createPreloadApi(argv: readonly string[]): PreloadApi {
  const subscriptions = new DaemonSubscriptions(ipcRenderer);
  return {
    daemon: createDaemonWire(ipcRenderer, subscriptions),
    machineSettings: createMachineSettingsBridge(ipcRenderer, subscriptions),
    native: {
      showOpenDialog: async <Purpose extends OpenDialogPurpose>(
        options: OpenDialogOptions<Purpose>,
      ): Promise<OpenDialogResults[Purpose]> =>
        (await ipcRenderer.invoke(
          BRIDGE_CHANNELS.showOpenDialog,
          options,
        )) as OpenDialogResults[Purpose],
      // Only the preload can read a dropped file's path; main checks it and mints the token.
      getDroppedFileRef: async (file): Promise<FilePathRef> =>
        (await ipcRenderer.invoke(
          BRIDGE_CHANNELS.getDroppedFileRef,
          webUtils.getPathForFile(file),
        )) as FilePathRef,
      savePastedImage: async (bytes): Promise<FilePathRef> =>
        (await ipcRenderer.invoke(BRIDGE_CHANNELS.savePastedImage, bytes)) as FilePathRef,
      openExternal: async (url): Promise<void> => {
        await ipcRenderer.invoke(BRIDGE_CHANNELS.openExternal, url);
      },
      openInEditor: async (ref, line): Promise<void> => {
        await ipcRenderer.invoke(BRIDGE_CHANNELS.openInEditor, { ref, line });
      },
      listEditors: async (): Promise<EditorEntry[]> =>
        (await ipcRenderer.invoke(BRIDGE_CHANNELS.listEditors)) as EditorEntry[],
      getNotificationPermission: async (): Promise<NotificationPermission> =>
        (await ipcRenderer.invoke(
          BRIDGE_CHANNELS.getNotificationPermission,
        )) as NotificationPermission,
      copyToClipboard: async (content): Promise<void> => {
        await ipcRenderer.invoke(BRIDGE_CHANNELS.copyToClipboard, content);
      },
      revealInFileExplorer: async (ref): Promise<void> => {
        await ipcRenderer.invoke(BRIDGE_CHANNELS.revealInFileExplorer, ref);
      },
    },
    update: createUpdateBridge(ipcRenderer),
    keyboardMap: {
      read: async (): Promise<KeyboardMapReading> =>
        (await ipcRenderer.invoke(BRIDGE_CHANNELS.readKeyboardMap)) as KeyboardMapReading,
      write: async (map): Promise<KeyboardMap> =>
        (await ipcRenderer.invoke(BRIDGE_CHANNELS.writeKeyboardMap, map)) as KeyboardMap,
    },
    window: createWindowBridge(ipcRenderer, readLastUsedWindowIdSwitch(argv)),
    app: readAppFactsSwitches(argv),
  };
}
