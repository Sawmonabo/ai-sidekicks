// The client helper's process: Electron starts this module as a utility process, where it loads
// the daemon client's Node-API addon and serves main over the parentPort.

import { connect } from "@ai-sidekicks/client-sdk";

import { serveClientHelper } from "./helper.js";

serveClientHelper(process.parentPort, { connect });
