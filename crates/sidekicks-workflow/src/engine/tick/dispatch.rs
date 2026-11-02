//! The tick's dispatch: the services a step's launch and its driver run through.

mod launch;

use std::sync::Arc;

use sidekicks_store::database::connection::read_pool::DatabaseReadPool;

use crate::engine::ports::EnginePorts;
use crate::expressions::evaluator::ExpressionEvaluator;
use crate::secrets::store::WorkflowSecretStore;

/// Launches and drives the steps the tick readies, through the engine's ports and the service's
/// expression thread, database reads, secret store and HTTP client.
#[derive(Clone)]
pub(crate) struct StepDispatch {
    /// The ports the program's workflow engine hands the dispatch.
    ports: EnginePorts,
    /// The service's one expression thread, which evaluates each step's templates.
    evaluator: ExpressionEvaluator,
    /// The database's read connections, which find the records of a step's secrets.
    reads: Arc<DatabaseReadPool>,
    /// The keychain store a step's secret values are read from.
    secrets: Arc<WorkflowSecretStore>,
    /// The daemon's HTTP client, which a step's context hands its executor.
    http: reqwest::Client,
}

impl StepDispatch {
    /// The dispatch over `ports`, `evaluator`, `reads`, `secrets` and `http`.
    pub(crate) fn new(
        ports: EnginePorts,
        evaluator: ExpressionEvaluator,
        reads: Arc<DatabaseReadPool>,
        secrets: Arc<WorkflowSecretStore>,
        http: reqwest::Client,
    ) -> Self {
        Self {
            ports,
            evaluator,
            reads,
            secrets,
            http,
        }
    }
}
