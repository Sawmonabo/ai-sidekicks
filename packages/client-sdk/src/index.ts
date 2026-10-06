export {
  connectToDaemon,
  type DaemonConnection,
  type DaemonConnectionObserver,
  type DaemonConnectionOptions,
} from "./daemon-connection.js";
export { createDaemonProviderClient, type DriverClient } from "./provider.js";
export {
  createDaemonSessionClient,
  SessionStreamDroppedError,
  type SessionClient,
  type SessionEventEnvelope,
  type SessionSubscribeOptions,
} from "./session.js";
export {
  JsonRpcClient,
  JsonRpcRemoteError,
  JsonRpcSchemaError,
  JsonRpcSubscriptionOverflowError,
  JsonRpcTransportClosedError,
  type ClientTransport,
  type JsonRpcClientOptions,
} from "./transport/json-rpc.js";
export {
  type LocalSubscriptionConsumer,
  type SubscribeAcknowledgment,
} from "./transport/subscription-consumer.js";
export {
  JsonRpcTransportPeerClosedError,
  JsonRpcTransportUnavailableError,
} from "./transport/local-socket.js";
