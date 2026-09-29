// Electron preload: the expose call alone.
//
// `contextBridge.exposeInMainWorld` is the only renderer-visible API: no `ipcRenderer`, no
// `require`, no `process` and no Node built-in. The preload runs sandboxed (`sandbox: true`
// is locked by `src/main/windows/window.ts`), and no auth material reaches
// `window.desktopBridge`, which `src/shared/preload-api.test-d.ts` enforces on the type.

import { contextBridge } from "electron";

import { preloadApi } from "./api.js";

contextBridge.exposeInMainWorld("desktopBridge", preloadApi);
