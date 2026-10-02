export { createDaemonProviderClient, type DriverClient } from "./provider-client.js";
export {
  createDaemonSessionClient,
  SessionStreamDroppedError,
  type SessionClient,
  type SessionEventEnvelope,
  type SessionSubscribeOptions,
} from "./session-client.js";
export {
  JsonRpcClient,
  JsonRpcRemoteError,
  JsonRpcSchemaError,
  JsonRpcTransportClosedError,
  type JsonRpcClientOptions,
} from "./transport/json-rpc-client.js";
export type { ClientTransport, Handler, LocalSubscriptionConsumer } from "./transport/types.js";
