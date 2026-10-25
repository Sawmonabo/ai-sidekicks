//! This machine's registrations under the users who own it, one row each, and the owner every
//! workflow-start check decides as: the local owner, unless this machine is registered under any
//! other user, so which user owns it is in doubt.

use std::borrow::Cow;
use std::sync::Arc;

use rusqlite::{OptionalExtension as _, named_params};
use sidekicks_contracts::session::id::UserId;
use sidekicks_contracts::wire::instant::WireInstant;

use crate::daemon::machine::local::LocalMachine;
use crate::database::connection::read_pool::{DatabaseReadError, DatabaseReadPool, ReadLength};
use crate::database::statement::{StatementBindings, WriteStatement, text_binding};
use crate::database::writer::{DatabaseWriter, WriteError};

/// The statements [`MachineRegistry`] prepares on a read connection: the other owner's row.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the daemon's start sizes the read connections' statement caches with it"
    )
)]
pub(crate) const MACHINE_REGISTRY_STATEMENT_CAPACITY: usize = 1;

// A re-registration refreshes only `updated_at`; the first registration's time stays.
const UPSERT_REGISTRATION_SQL: &str = "INSERT INTO machine_trust_state
    (machine_id, owner_user_id, established_at, updated_at)
  VALUES (@machine_id, @owner_user_id, @now, @now)
  ON CONFLICT (machine_id, owner_user_id) DO UPDATE SET updated_at = excluded.updated_at";

const SELECT_OTHER_OWNER_SQL: &str = "SELECT 1 FROM machine_trust_state
  WHERE machine_id = @machine_id AND owner_user_id <> @owner_user_id
  LIMIT 1";

/// Why this machine's owner could not be read.
#[derive(Debug, thiserror::Error)]
pub(crate) enum MachineRegistryReadError {
    /// SQLite refused the read.
    #[error("this machine's registrations could not be read")]
    Database(#[from] rusqlite::Error),
    /// The read pool is closed, a connection did not open, or the read's task did not finish.
    #[error(transparent)]
    Pool(#[from] DatabaseReadError),
}

/// This machine's registrations, kept in `machine_trust_state`, and the owner they leave it.
pub(crate) struct MachineRegistry {
    /// Where the registrations are read.
    reads: Arc<DatabaseReadPool>,
    /// Where a registration is written.
    writer: Arc<DatabaseWriter>,
    /// This machine, with its local owner.
    machine: LocalMachine,
}

impl MachineRegistry {
    /// The registrations of `machine`, read through `reads` and written through `writer`.
    pub(crate) fn new(
        reads: Arc<DatabaseReadPool>,
        writer: Arc<DatabaseWriter>,
        machine: LocalMachine,
    ) -> Self {
        Self {
            reads,
            writer,
            machine,
        }
    }

    /// Registers this machine under `owner_user_id` once committed; a re-registration keeps the
    /// first registration's time and refreshes only the last. Fails as the write does.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the registration with the control plane records this machine under its owner"
        )
    )]
    pub(crate) async fn register(&self, owner_user_id: &UserId) -> Result<(), WriteError> {
        let now = WireInstant::now();
        self.writer
            .write(vec![WriteStatement {
                sql: Cow::Borrowed(UPSERT_REGISTRATION_SQL),
                bindings: StatementBindings::Named(vec![
                    text_binding("@machine_id", self.machine.machine_id.as_str()),
                    text_binding("@owner_user_id", owner_user_id.text().as_str()),
                    text_binding("@now", now.as_str()),
                ]),
                expected_row_count: Some(1),
            }])
            .await?;
        Ok(())
    }

    /// The user every policy check on this machine decides as: its local owner, unregistered or
    /// registered under that owner alike, and `None` once it is registered under any other user.
    /// Fails as the read does.
    pub(crate) async fn read_owner(&self) -> Result<Option<UserId>, MachineRegistryReadError> {
        let machine_id = self.machine.machine_id.clone();
        let owner_user_id = self.machine.owner_user_id;
        let is_owned_by_another = self
            .reads
            .read(ReadLength::Short, move |reader| {
                Ok::<_, MachineRegistryReadError>(
                    reader
                        .prepare_cached(SELECT_OTHER_OWNER_SQL)?
                        .query_row(
                            named_params! {
                                "@machine_id": machine_id.as_str(),
                                "@owner_user_id": owner_user_id.text().as_str(),
                            },
                            |_row| Ok(()),
                        )
                        .optional()?
                        .is_some(),
                )
            })
            .await?;
        Ok((!is_owned_by_another).then_some(owner_user_id))
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use rstest::rstest;
    use sidekicks_contracts::machine::id::MachineId;
    use sidekicks_contracts::session::id::UserId;

    use super::{MACHINE_REGISTRY_STATEMENT_CAPACITY, MachineRegistry};
    use crate::daemon::machine::local::LocalMachine;
    use crate::database::connection::read_pool::DatabaseReadPool;
    use crate::database::writer::test_file::TestDatabase;
    use crate::database::writer::{DatabaseWriter, DatabaseWriterOptions};
    use sidekicks_contracts::wire::id::mint_uuid_v7;

    fn user_id() -> UserId {
        UserId::try_from(mint_uuid_v7()).expect("a minted UUID is a user id")
    }

    fn machine_id() -> MachineId {
        MachineId::new(mint_uuid_v7().to_string()).expect("a minted UUID is a machine id")
    }

    async fn registry_of(database: &TestDatabase, machine: LocalMachine) -> MachineRegistry {
        let writer = DatabaseWriter::open(database.opener(), DatabaseWriterOptions::default())
            .await
            .expect("the writer opens its database");
        MachineRegistry::new(
            Arc::new(DatabaseReadPool::new(
                database.path(),
                MACHINE_REGISTRY_STATEMENT_CAPACITY,
            )),
            Arc::new(writer),
            machine,
        )
    }

    /// Who a registration names, beside the local owner.
    #[derive(Clone, Copy, Debug)]
    enum Registered {
        Nothing,
        ThisMachineUnderItsOwner,
        ThisMachineUnderAnotherUser,
        AnotherMachineUnderAnotherUser,
    }

    // The owner resolves unless this machine is registered under another user. Killed by `<>`
    // read as `=`, and by a read that ignores the machine id.
    #[rstest]
    #[case::unregistered(Registered::Nothing, true)]
    #[case::under_its_owner(Registered::ThisMachineUnderItsOwner, true)]
    #[case::under_another_user(Registered::ThisMachineUnderAnotherUser, false)]
    #[case::another_machine(Registered::AnotherMachineUnderAnotherUser, true)]
    #[tokio::test]
    async fn the_owner_resolves_unless_this_machine_is_registered_under_another_user(
        #[case] registered: Registered,
        #[case] is_resolved: bool,
    ) {
        let database = TestDatabase::new();
        let machine = LocalMachine {
            machine_id: machine_id(),
            owner_user_id: user_id(),
            name: "desk".to_owned(),
        };
        let owner = machine.owner_user_id;
        let registry = registry_of(&database, machine.clone()).await;
        match registered {
            Registered::Nothing => {}
            Registered::ThisMachineUnderItsOwner => {
                registry.register(&owner).await.expect("it registers");
            }
            Registered::ThisMachineUnderAnotherUser => {
                registry.register(&user_id()).await.expect("it registers");
            }
            Registered::AnotherMachineUnderAnotherUser => {
                let other = registry_of(
                    &database,
                    LocalMachine {
                        machine_id: machine_id(),
                        ..machine
                    },
                )
                .await;
                other.register(&user_id()).await.expect("it registers");
            }
        }

        let resolved = registry.read_owner().await.expect("the owner reads");

        assert_eq!(resolved, is_resolved.then_some(owner));
    }

    // A re-registration keeps the first registration's time and moves the last. Killed by an
    // upsert that also sets `established_at`.
    #[tokio::test]
    async fn a_re_registration_keeps_its_first_time() {
        let database = TestDatabase::new();
        let owner = user_id();
        let registry = registry_of(
            &database,
            LocalMachine {
                machine_id: machine_id(),
                owner_user_id: owner,
                name: "desk".to_owned(),
            },
        )
        .await;
        registry.register(&owner).await.expect("it registers");
        database
            .reader()
            .execute(
                "UPDATE machine_trust_state SET established_at = '2026-01-01T00:00:00.000Z',
                   updated_at = '2026-01-01T00:00:00.000Z'",
                [],
            )
            .expect("the test dates the registration back");

        registry.register(&owner).await.expect("it registers again");

        let (established_at, updated_at): (String, String) = database
            .reader()
            .query_row(
                "SELECT established_at, updated_at FROM machine_trust_state",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("the test reads the registration");
        assert_eq!(established_at, "2026-01-01T00:00:00.000Z");
        assert_ne!(updated_at, "2026-01-01T00:00:00.000Z");
    }
}
