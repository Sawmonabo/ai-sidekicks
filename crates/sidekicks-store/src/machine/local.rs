//! This machine's id, its owner's user id and its friendly name: minted and read at the daemon's
//! first start, then read back at every later start, so the id a mount, an event or a registration
//! carries never moves, and the owner every policy check decides as is the one user from the first
//! start on, with or without a hosted account. The name follows a rename of this machine, so every
//! reader of the row shows the name the person gave it.

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

const UPDATE_LOCAL_MACHINE_NAME_SQL: &str =
    "UPDATE local_machine SET name = @name WHERE machine_id = @machineId";

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

/// This machine's stored row, or `None` before the first start stored it. Fails with
/// [`LocalMachineError`] when the read fails or a stored id does not parse.
pub async fn read_local_machine(
    reads: &DatabaseReadPool,
) -> Result<Option<LocalMachine>, LocalMachineError> {
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
    let Some((machine_id, owner_user_id, name)) = stored else {
        return Ok(None);
    };
    Ok(Some(LocalMachine {
        machine_id: MachineId::new(machine_id).ok_or(LocalMachineError::StoredMachineId)?,
        owner_user_id: UserId::new(&owner_user_id).map_err(LocalMachineError::StoredOwnerUserId)?,
        name,
    }))
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
    if let Some(machine) = read_local_machine(reads).await? {
        return Ok(machine);
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

/// Records `name` as this machine's friendly name once committed, when `machine_id` is this
/// machine's; a rename of another machine changes nothing. Fails as the write does.
pub async fn record_local_machine_rename(
    writer: &DatabaseWriter,
    machine_id: &MachineId,
    name: &str,
) -> Result<(), WriteError> {
    writer
        .write(vec![WriteStatement {
            sql: Cow::Borrowed(UPDATE_LOCAL_MACHINE_NAME_SQL),
            bindings: StatementBindings::Named(vec![
                text_binding("@name", name),
                text_binding("@machineId", machine_id.as_str()),
            ]),
            expected_row_count: None,
        }])
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use rusqlite::params;
    use sidekicks_contracts::machine::id::MachineId;
    use sidekicks_contracts::wire::id::mint_uuid_v7;

    use super::{read_local_machine, record_local_machine_rename};
    use crate::database::connection::read_pool::DatabaseReadPool;
    use crate::database::schema::schema_parts;
    use crate::database::writer::test_file::TestDatabase;
    use crate::database::writer::{DatabaseWriter, DatabaseWriterOptions};

    fn machine_id() -> MachineId {
        MachineId::new(mint_uuid_v7().to_string()).expect("a minted UUID is a machine id")
    }

    /// A rename reported for this machine replaces its name; one for another machine changes
    /// nothing. Killed by dropping the `machine_id` clause, and by a rename that is not written.
    #[tokio::test]
    async fn a_rename_of_this_machine_replaces_its_name() {
        let database = TestDatabase::new(schema_parts());
        let writer = DatabaseWriter::open(database.opener(), DatabaseWriterOptions::default())
            .await
            .expect("the writer opens its database");
        let this_machine = machine_id();
        database
            .reader()
            .execute(
                "INSERT INTO local_machine (singleton, machine_id, owner_user_id, name, minted_at)
                 VALUES (1, ?1, ?2, 'desk', '2026-10-27T00:00:00.000Z')",
                params![this_machine.as_str(), mint_uuid_v7().to_string()],
            )
            .expect("the test stores this machine's row");
        let reads = DatabaseReadPool::new(database.path(), 0);
        let name = async || {
            read_local_machine(&reads)
                .await
                .expect("the row reads")
                .expect("the row is stored")
                .name
        };

        record_local_machine_rename(&writer, &machine_id(), "laptop")
            .await
            .expect("another machine's rename commits");
        assert_eq!(name().await, "desk");

        record_local_machine_rename(&writer, &this_machine, "studio")
            .await
            .expect("this machine's rename commits");
        assert_eq!(name().await, "studio");
    }
}
