// Electron preload: the expose calls alone.
//
// `contextBridge.exposeInMainWorld` is the only renderer-visible API: no `ipcRenderer`, no
// `require`, no `process`, no Node built-in. The preload runs sandboxed (`sandbox: true` in
// `src/main/windows/window.ts`), and `src/shared/preload-api.test-d.ts` keeps auth material
// out of the bridge's type.

import { contextBridge } from "electron";

import { FIXTURE_LAUNCH_GLOBAL, readFixtureLaunchSwitches } from "@shared/fixture-launch.js";
import { createPreloadApi } from "./api.js";

// Set by the `define` block in `electron.vite.config.ts`: `true` in the development and
// fixtures builds, `false` in the release build, which folds the branch below away.
declare const __FIXTURE_BUILD__: boolean;

contextBridge.exposeInMainWorld("desktopBridge", createPreloadApi(process.argv));

// The fixture launch gets a global of its own so the product bridge carries no fixture
// member. A window started without one gets no global.
if (__FIXTURE_BUILD__) {
  const fixtureLaunch = readFixtureLaunchSwitches(process.argv);
  if (fixtureLaunch !== undefined) {
    contextBridge.exposeInMainWorld(FIXTURE_LAUNCH_GLOBAL, fixtureLaunch);
  }
}
