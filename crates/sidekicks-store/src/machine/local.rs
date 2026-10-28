//! This machine's id, its owner's user id and its friendly name: minted and read at the daemon's
//! first start, then read back unchanged at every later start, so the id a mount, an event or a
//! registration carries never moves, and the owner every policy check decides as is the one user
//! from the first start on, with or without a hosted account.

use std::borrow::Cow;

use rusqlite::OptionalExtension as _;
use rusqlite::types::Value;
use sidekicks_contracts::machine::id::MachineId;
use sidekicks_contracts::session::id::UserId;
use sidekicks_contracts::wire::id::IdError;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_platforms::{MachineNameError, Spawner, machine_name};

use crate::database::connection::read_pool::{DatabaseReadError, DatabaseReadPool, ReadLength};
use crate::database::statement::{StatementBindings, WriteStatement, text_binding};
use crate::database::writer::{DatabaseWriter, WriteError};

const SELECT_LOCAL_MACHINE_SQL: &str =
    "SELECT machine_id, owner_user_id, name FROM local_machine WHERE singleton = 1";

const INSERT_LOCAL_MACHINE_SQL: &str =
    "INSERT INTO local_machine (singleton, machine_id, owner_user_id, name, minted_at)
  VALUES (1, @machineId, @ownerUserId, @name, @mintedAt)";

/// This machine as the daemon knows it, with the one user who owns it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LocalMachine {
    /// The machine's id.
    pub machine_id: MachineId,
    /// Minted once at the first start; a hosted account signed in to later attaches to it.
    pub owner_user_id: UserId,
    /// The machine's friendly name, read at the first start.
    pub name: String,
}

/// Why this machine's row could not be read or minted.
#[derive(Debug, thiserror::Error)]
pub enum LocalMachineError {
    /// SQLite refused the read.
    #[error("this machine's row could not be read")]
    Database(#[from] rusqlite::Error),
    /// The read pool is closed, a connection did not open, or the read's task did not finish.
    #[error(transparent)]
    Pool(#[from] DatabaseReadError),
    /// The stored machine id is no machine id.
    #[error("this machine's stored id is not a machine id")]
    StoredMachineId,
    /// The stored owner id is no user id.
    #[error("this machine's stored owner id is not a user id")]
    StoredOwnerUserId(#[source] IdError),
    /// The friendly name could not be read at the first start.
    #[error(transparent)]
    Name(#[from] MachineNameError),
    /// The minted row was not stored.
    #[error("this machine's minted row was not stored")]
    Write(#[from] WriteError),
}

/// Reads this machine's stored row, or at the first start mints the machine id and the owner's
/// user id, reads the friendly name on `spawner`, and stores them for every later start. Fails
/// with [`LocalMachineError`] when the read, the name or the write fails, or a stored id does not
/// parse.
pub async fn read_or_mint_local_machine(
    reads: &DatabaseReadPool,
    writer: &DatabaseWriter,
    spawner: &Spawner,
) -> Result<LocalMachine, LocalMachineError> {
    let stored = reads
        .read(ReadLength::Short, |connection| {
            Ok::<_, LocalMachineError>(
                connection
                    .prepare(SELECT_LOCAL_MACHINE_SQL)?
                    .query_row([], |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                        ))
                    })
                    .optional()?,
            )
        })
        .await?;
    if let Some((machine_id, owner_user_id, name)) = stored {
        return Ok(LocalMachine {
            machine_id: MachineId::new(machine_id).ok_or(LocalMachineError::StoredMachineId)?,
            owner_user_id: UserId::new(&owner_user_id)
                .map_err(LocalMachineError::StoredOwnerUserId)?,
            name,
        });
    }
    let machine_id = mint_uuid_v7().to_string();
    let owner_user_id = mint_uuid_v7().to_string();
    let name = machine_name(spawner).await?;
    writer
        .write(vec![WriteStatement {
            sql: Cow::Borrowed(INSERT_LOCAL_MACHINE_SQL),
            bindings: StatementBindings::Named(vec![
                text_binding("@machineId", &machine_id),
                text_binding("@ownerUserId", &owner_user_id),
                (Cow::Borrowed("@name"), Value::Text(name.clone())),
                text_binding("@mintedAt", WireInstant::now().as_str()),
            ]),
            expected_row_count: Some(1),
        }])
        .await?;
    Ok(LocalMachine {
        machine_id: MachineId::new(machine_id).expect("a minted UUID is a machine id"),
        owner_user_id: UserId::new(&owner_user_id).expect("a minted UUID is a user id"),
        name,
    })
}
