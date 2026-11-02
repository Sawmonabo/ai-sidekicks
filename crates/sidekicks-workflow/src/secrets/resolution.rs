//! The resolution of a step's secrets at its launch. Only a parameter its kind marks sensitive is
//! read for a reference, and only when its whole value is one `secret://<scope>/<name>` reference;
//! the save already refused a reference anywhere else. A `shared` reference resolves on every run,
//! a `project` one only in the project the run works in.
//!
//! Resolution is two steps, so no database connection is held across a keychain call: the records
//! are found on a read connection, then their values are read from the keychain. The result names
//! parameters, never a command line or an environment: the launcher decides how a value rides.

#[cfg(test)]
mod tests;

use rusqlite::{Connection, OptionalExtension as _, named_params};
use secrecy::SecretString;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::project::ProjectId;
use sidekicks_contracts::workflow::secret::{
    WorkflowSecretId, WorkflowSecretNotFoundDetails, WorkflowSecretReference,
    WorkflowSecretReferenceNotFound, WorkflowSecretScope, WorkflowSecretStoreUnavailableDetails,
};
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_ipc::registry::HandlerError;
use sidekicks_store::credential_store::KeychainRefusal;
use sidekicks_store::database::connection::read_pool::DatabaseReadError;

use crate::secrets::store::WorkflowSecretStore;

/// The statements [`find_step_secrets`] runs on a read connection: the live record of one
/// reference.
pub const STEP_SECRET_STATEMENT_CAPACITY: usize = 1;

// A record being deleted no longer resolves, so a value its delete is removing is never handed out.
const LIVE_SECRET_RECORD_SQL: &str = "SELECT id FROM workflow_secrets
  WHERE scope = @scope AND scope_ref = @scope_ref AND name = @name
    AND removal_requested_at IS NULL";

/// A sensitive parameter's reference and the record that holds it, which
/// [`resolve_step_secrets`] reads the value of.
#[derive(Debug)]
pub struct FoundStepSecret {
    /// The parameter's name.
    parameter: String,
    /// The reference the parameter stores.
    reference: WorkflowSecretReference,
    /// The record the reference names.
    secret_id: WorkflowSecretId,
}

/// A sensitive parameter's secret value, for the launcher to hand the step.
#[derive(Debug)]
pub struct ResolvedStepSecret {
    /// The parameter's name.
    pub parameter: String,
    /// The secret's value.
    pub value: SecretString,
}

/// Why a step's secrets did not resolve; the step fails without starting. Each refusal answers
/// its own code, and none names a secret's value.
#[derive(Debug, thiserror::Error)]
pub enum StepSecretRefusal {
    /// No live record holds the reference, the run works in no project for a `project` one, or the
    /// keychain holds no value for its record (`workflow.secret.notFound`).
    #[error("No secret is stored for {reference}.")]
    NotFound {
        /// The reference that did not resolve.
        reference: WorkflowSecretReference,
    },
    /// The keychain is locked or unavailable (`workflow.secret.storeUnavailable`).
    #[error(transparent)]
    StoreUnavailable(KeychainRefusal),
    /// SQLite refused the read of a secret's record.
    #[error("a read of a workflow secret's record failed")]
    Database(#[from] rusqlite::Error),
    /// The read pool is closed, a connection did not open, or the read's blocking task did not
    /// finish.
    #[error(transparent)]
    Pool(#[from] DatabaseReadError),
}

impl From<StepSecretRefusal> for HandlerError {
    /// A reference that did not resolve and a keychain that could not be used answer their own
    /// codes; a failed read is a fault in the daemon.
    fn from(refusal: StepSecretRefusal) -> Self {
        let message = refusal.to_string();
        match refusal {
            StepSecretRefusal::NotFound { reference } => {
                let details =
                    WorkflowSecretNotFoundDetails::Reference(WorkflowSecretReferenceNotFound {
                        reference,
                        secret_id: None,
                    });
                Self::Refused(
                    DomainError::new(message, RefusalCode::WorkflowSecretNotFound)
                        .with_detail(details),
                )
            }
            StepSecretRefusal::StoreUnavailable(keychain_refusal) => {
                Self::Refused(DomainError::keychain_refused(
                    keychain_refusal,
                    RefusalCode::WorkflowSecretStoreUnavailable,
                    |cause| WorkflowSecretStoreUnavailableDetails { cause },
                ))
            }
            fault @ (StepSecretRefusal::Database(_) | StepSecretRefusal::Pool(_)) => {
                Self::Internal(Box::new(fault))
            }
        }
    }
}

/// Finds the record of each sensitive parameter's reference, given each parameter as its name, its
/// value's text and whether its kind marks it sensitive, in a run working in `project` or in none.
/// A parameter not marked sensitive and a sensitive one holding a plain value are left out. Fails
/// with [`StepSecretRefusal::NotFound`] for the first reference no live record holds, or with
/// [`StepSecretRefusal::Database`] when the read does.
pub fn find_step_secrets<'parameter>(
    connection: &Connection,
    project: Option<&ProjectId>,
    parameters: impl IntoIterator<Item = (&'parameter str, &'parameter str, bool)>,
) -> Result<Vec<FoundStepSecret>, StepSecretRefusal> {
    let project_text = project.map(ProjectId::text);
    let mut found = Vec::new();
    for (parameter, value, is_sensitive) in parameters {
        if !is_sensitive {
            continue;
        }
        let Ok(reference) = value.parse::<WorkflowSecretReference>() else {
            continue;
        };
        let scope_ref = match (reference.scope, &project_text) {
            (WorkflowSecretScope::Shared, _) => "",
            (WorkflowSecretScope::Project, Some(project_text)) => project_text.as_str(),
            (WorkflowSecretScope::Project, None) => {
                return Err(StepSecretRefusal::NotFound { reference });
            }
        };
        let secret_id = connection
            .prepare_cached(LIVE_SECRET_RECORD_SQL)?
            .query_row(
                named_params! {
                    "@scope": <&'static str>::from(reference.scope),
                    "@scope_ref": scope_ref,
                    "@name": reference.name.as_str(),
                },
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        let Some(secret_id) = secret_id else {
            return Err(StepSecretRefusal::NotFound { reference });
        };
        let secret_id =
            WorkflowSecretId::new(&secret_id).expect("a secret's id is the UUID the daemon minted");
        found.push(FoundStepSecret {
            parameter: parameter.to_owned(),
            reference,
            secret_id,
        });
    }
    Ok(found)
}

/// Reads each found secret's value from `store`, in the order found. Fails with
/// [`StepSecretRefusal::NotFound`] for the first record whose keychain holds no value, or with
/// [`StepSecretRefusal::StoreUnavailable`] when the keychain cannot be used.
pub async fn resolve_step_secrets(
    store: &WorkflowSecretStore,
    found: Vec<FoundStepSecret>,
) -> Result<Vec<ResolvedStepSecret>, StepSecretRefusal> {
    let mut resolved = Vec::with_capacity(found.len());
    for FoundStepSecret {
        parameter,
        reference,
        secret_id,
    } in found
    {
        let value = store
            .resolve(secret_id)
            .await
            .map_err(StepSecretRefusal::StoreUnavailable)?
            .ok_or(StepSecretRefusal::NotFound { reference })?;
        resolved.push(ResolvedStepSecret { parameter, value });
    }
    Ok(resolved)
}
