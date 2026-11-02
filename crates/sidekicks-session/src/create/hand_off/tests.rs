use std::error::Error;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, Weak};

use futures::FutureExt as _;
use futures::future::BoxFuture;
use rstest::rstest;
use rusqlite::{Connection, OptionalExtension};
use sidekicks_contracts::plan::PlanId;
use sidekicks_contracts::project::ProjectId;
use sidekicks_contracts::repo::mount::{ExecutionMode, RepoMountId};
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queue::{PlanMessage, PlanMessageKind, QueueItemId};
use sidekicks_contracts::session::controls::methods::PermissionLevel;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::methods::SessionState;
use sidekicks_contracts::trust_statement::DeviceId;
use sidekicks_contracts::wire::id::{ClientUuid, mint_uuid_v7};
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_store::database::writer::DatabaseWriter;
use sidekicks_workspace::clone::service::CloneAttachedListener;
use sidekicks_workspace::repo::mount::service::managed_folder_hold_statement;

use super::{HandOffSeeding, SessionHandOff, record_hand_off_statement};
use crate::create::tests::{
    FIRST_ACCOUNT, Fixture, PROJECT_ID, SECOND_ACCOUNT, chat_request, lead, new_key,
    project_request,
};
use crate::queue_store::{NewQueueItem, QueueItemBody, insert_queue_item_statement};

const TITLE: &str = "Add the export button";
const MANAGED_MOUNTS: &str = "SELECT count(*) FROM repo_mounts WHERE origin = 'managed'";

/// Where the planning session works when its plan is handed off.
#[derive(Clone, Copy, Debug)]
enum PlanningSession {
    /// A project session at its mount's root.
    ProjectAtRoot,
    /// A project session in a subfolder of its repository.
    ProjectInSubfolder,
    /// A chat in its own folder.
    Chat,
}

/// Stores the hand-off of a plan made in `planning` to the fresh session `fresh`, as the verdict's
/// write does, and answers it.
async fn record_hand_off(
    writer: &DatabaseWriter,
    planning: SessionId,
    fresh: SessionId,
) -> SessionHandOff {
    let hand_off = SessionHandOff {
        session_id: fresh,
        client_idempotency_key: hand_off_key(fresh),
        plan_id: PlanId::try_from(mint_uuid_v7()).expect("a minted UUID is a plan id"),
        planning_session_id: planning,
        lead: lead(),
        permission_level: PermissionLevel::Ask,
        title: TITLE.to_owned(),
        device_id: DeviceId::new("device-1".to_owned()).expect("a device id"),
    };
    writer
        .write(vec![record_hand_off_statement(&hand_off)])
        .await
        .expect("the hand-off is recorded");
    hand_off
}

fn hand_off_key(fresh: SessionId) -> ClientUuid {
    ClientUuid::new(fresh.to_string()).expect("a session id is a client UUID")
}

// Dies to a second session minted for the key, to the birth run again on a born key (its record
// is refused), to `provisionedWorktree`, to `create_chat` called (a managed mount made), to the
// folder not written or the mount's root not folded to none, to the finish run (`active`, or a
// workspace bound), to the name missing or written with another origin, and to the planning
// session's account kept in place of the provider's current one.
#[rstest]
#[case::project_at_root(PlanningSession::ProjectAtRoot)]
#[case::project_in_subfolder(PlanningSession::ProjectInSubfolder)]
#[case::chat(PlanningSession::Chat)]
#[tokio::test]
async fn a_hand_off_births_its_fresh_session_once_where_the_planning_session_works(
    #[case] planning: PlanningSession,
) {
    let fixture = Fixture::new().await;
    let request = match planning {
        PlanningSession::ProjectAtRoot | PlanningSession::ProjectInSubfolder => {
            project_request(new_key(), None)
        }
        PlanningSession::Chat => chat_request(new_key()),
    };
    let planning_session = fixture
        .creation
        .create(request)
        .await
        .expect("the planning session is made")
        .session_id;
    let folder = match planning {
        PlanningSession::ProjectAtRoot | PlanningSession::Chat => "mount.canonical_root",
        PlanningSession::ProjectInSubfolder => "mount.canonical_root || '/packages/export'",
    };
    // The bind leaves the folder to the workspace's preparation, which a test stands in for.
    fixture.execute(&format!(
        "UPDATE workspaces SET state = 'ready', fs_root = \
         (SELECT {folder} FROM repo_mounts AS mount WHERE mount.id = workspaces.repo_mount_id) \
         WHERE session_id = '{planning_session}'"
    ));
    fixture.execute(&format!(
        "UPDATE provider_accounts SET is_default = 0 WHERE account_id = '{FIRST_ACCOUNT}';
         UPDATE provider_accounts SET is_default = 1 WHERE account_id = '{SECOND_ACCOUNT}';"
    ));
    let fresh = SessionId::try_from(mint_uuid_v7()).expect("a minted UUID is a session id");
    record_hand_off(&fixture.writer, planning_session, fresh).await;
    let managed_mounts = fixture.count(MANAGED_MOUNTS);

    for _ in 0..2 {
        fixture
            .creation
            .create_handed_off(hand_off_key(fresh))
            .await
            .expect("the fresh session is born, or answered once born");
    }

    assert_eq!(
        fixture.count(&format!(
            "SELECT count(*) FROM session_events \
             WHERE session_id = '{fresh}' AND type = 'session.created'"
        )),
        1
    );
    assert_eq!(fixture.count("SELECT count(*) FROM sessions"), 2);
    assert_eq!(
        fixture.text(&format!("SELECT state FROM sessions WHERE id = '{fresh}'")),
        Some("provisioning".to_owned())
    );
    assert_eq!(
        fixture.count(&format!(
            "SELECT count(*) FROM workspaces WHERE session_id = '{fresh}'"
        )),
        0
    );
    assert_eq!(fixture.count(MANAGED_MOUNTS), managed_mounts);

    let recorded = fixture
        .creation
        .read_recorded(hand_off_key(fresh))
        .await
        .expect("the record reads")
        .expect("the birth recorded its create");
    let session = recorded.session;
    assert_eq!(session.session_id, fresh);
    assert_eq!(session.execution_mode, ExecutionMode::BoundRoot);
    let project = match planning {
        PlanningSession::ProjectAtRoot | PlanningSession::ProjectInSubfolder => {
            Some(ProjectId::new(PROJECT_ID).expect("a project id"))
        }
        PlanningSession::Chat => None,
    };
    assert_eq!(session.project_id, project);
    assert_eq!(session.provider_account_id.as_str(), SECOND_ACCOUNT);
    let directory = match planning {
        PlanningSession::ProjectAtRoot | PlanningSession::Chat => None,
        PlanningSession::ProjectInSubfolder => fixture.text(&format!(
            "SELECT fs_root FROM workspaces WHERE session_id = '{planning_session}'"
        )),
    };
    assert_eq!(
        session
            .directory
            .as_ref()
            .map(|path| path.as_str().to_owned()),
        directory
    );

    assert_eq!(
        fixture.text(&format!("SELECT name FROM sessions WHERE id = '{fresh}'")),
        Some(TITLE.to_owned())
    );
    assert_eq!(
        fixture.text(&format!(
            "SELECT json_extract(payload, '$.origin') FROM session_events \
             WHERE session_id = '{fresh}' AND type = 'session.renamed'"
        )),
        Some("auto".to_owned())
    );
}

/// One call the seeding port took: its method, the fresh session, and the session's state as a
/// connection of the port's own read it then, `None` for a session not yet born.
type SeedingCall = (&'static str, SessionId, Option<String>);

/// A seeding port that writes nothing and records each call it takes.
struct RecordingSeeding {
    database: PathBuf,
    calls: Mutex<Vec<SeedingCall>>,
}

impl RecordingSeeding {
    /// The port over the fixture's database, set as the creation's seeding port; the test keeps
    /// the port, which the creation holds only weakly.
    fn set_on(fixture: &Fixture) -> Arc<Self> {
        let seeding = Arc::new(Self {
            database: fixture.database.path(),
            calls: Mutex::new(Vec::new()),
        });
        let port: Weak<Self> = Arc::downgrade(&seeding);
        fixture
            .creation
            .set_hand_off_seeding(port)
            .expect("the port is set once");
        seeding
    }

    fn record(&self, method: &'static str, session_id: SessionId) {
        let state = Connection::open(&self.database)
            .expect("the port opens its own connection")
            .query_row(
                "SELECT state FROM sessions WHERE id = ?1",
                [session_id.text().as_str()],
                |row| row.get(0),
            )
            .optional()
            .expect("the port reads the session's state");
        self.calls
            .lock()
            .expect("the calls are not poisoned")
            .push((method, session_id, state));
    }

    fn calls(&self) -> Vec<SeedingCall> {
        self.calls
            .lock()
            .expect("the calls are not poisoned")
            .clone()
    }
}

impl HandOffSeeding for RecordingSeeding {
    fn write_transcript_file<'a>(
        &'a self,
        hand_off: &'a SessionHandOff,
    ) -> BoxFuture<'a, Result<(), Box<dyn Error + Send + Sync>>> {
        self.record("write_transcript_file", hand_off.session_id);
        async { Ok(()) }.boxed()
    }

    fn write_seed_plan<'a>(
        &'a self,
        hand_off: &'a SessionHandOff,
    ) -> BoxFuture<'a, Result<(), Box<dyn Error + Send + Sync>>> {
        self.record("write_seed_plan", hand_off.session_id);
        async { Ok(()) }.boxed()
    }

    fn finish_hand_off(
        &self,
        hand_off: SessionHandOff,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>> {
        self.record("finish_hand_off", hand_off.session_id);
        async { Ok(()) }.boxed()
    }
}

/// Makes a project planning session working in `packages/export` of its repository, that folder
/// made on disk when `is_folder_made`, and answers the session.
async fn plan_in_subfolder(fixture: &Fixture, is_folder_made: bool) -> SessionId {
    let planning = fixture
        .creation
        .create(project_request(new_key(), None))
        .await
        .expect("the planning session is made")
        .session_id;
    // The bind leaves the folder to the workspace's preparation, which a test stands in for.
    fixture.execute(&format!(
        "UPDATE workspaces SET state = 'ready', fs_root = \
         (SELECT mount.canonical_root || '/packages/export' FROM repo_mounts AS mount \
          WHERE mount.id = workspaces.repo_mount_id) \
         WHERE session_id = '{planning}'"
    ));
    if is_folder_made {
        let folder = fixture
            .text(&format!(
                "SELECT fs_root FROM workspaces WHERE session_id = '{planning}'"
            ))
            .expect("the planning workspace has its folder");
        std::fs::create_dir_all(folder).expect("the planning folder is made");
    }
    planning
}

fn bound_root(fixture: &Fixture, session_id: SessionId) -> Option<String> {
    fixture.text(&format!(
        "SELECT json_extract(metadata, '$.boundRoot') FROM workspaces \
         WHERE session_id = '{session_id}'"
    ))
}

// Dies to the folder dropped from the bind (the made folder binds the root), to no fall-back (the
// gone folder fails `repoMount.outsideTrustEnvelope`), to the starting read used in place of the
// hand-off's level and mode `build` (`readonly` or `plan`), to the port called after the
// activation (`active` seen) or skipped, and to the finish run again on an active session.
#[rstest]
#[case::folder_made(true)]
#[case::folder_gone(false)]
#[tokio::test]
async fn a_hand_off_s_finish_binds_its_folder_seeds_and_activates_at_the_verdict_s_level(
    #[case] is_folder_made: bool,
) {
    let fixture = Fixture::new().await;
    let planning = plan_in_subfolder(&fixture, is_folder_made).await;
    let fresh = SessionId::try_from(mint_uuid_v7()).expect("a minted UUID is a session id");
    record_hand_off(&fixture.writer, planning, fresh).await;
    fixture
        .creation
        .create_handed_off(hand_off_key(fresh))
        .await
        .expect("the fresh session is born");
    let seeding = RecordingSeeding::set_on(&fixture);

    for _ in 0..2 {
        let state = fixture
            .creation
            .finish_handed_off(hand_off_key(fresh))
            .await
            .expect("the hand-off finishes, or is answered once finished");
        assert_eq!(state, SessionState::Active);
    }

    let expected_root = if is_folder_made {
        fixture.text(&format!(
            "SELECT fs_root FROM workspaces WHERE session_id = '{planning}'"
        ))
    } else {
        bound_root(&fixture, planning)
    };
    assert!(expected_root.is_some());
    assert_eq!(bound_root(&fixture, fresh), expected_root);
    let provisioning = Some("provisioning".to_owned());
    assert_eq!(
        seeding.calls(),
        vec![
            ("write_transcript_file", fresh, provisioning.clone()),
            ("write_seed_plan", fresh, provisioning),
        ]
    );
    assert_eq!(
        fixture.text(&format!(
            "SELECT permission_level FROM sessions WHERE id = '{fresh}'"
        )),
        Some("ask".to_owned())
    );
    assert_eq!(
        fixture.text(&format!(
            "SELECT session_mode FROM session_console_state WHERE session_id = '{fresh}'"
        )),
        Some("build".to_owned())
    );
}

// Dies to the chat's mount read keyed on the chat the folder was made for: the fresh chat, which
// only holds the planning chat's folder, fails `ChatWithoutMount` at `bind`.
#[tokio::test]
async fn a_chat_s_hand_off_binds_its_fresh_chat_on_the_planning_chat_s_folder() {
    let fixture = Fixture::new().await;
    let planning = fixture
        .creation
        .create(chat_request(new_key()))
        .await
        .expect("the planning chat is made")
        .session_id;
    let planning_mount = fixture
        .text(&format!(
            "SELECT id FROM repo_mounts WHERE managed_session_id = '{planning}'"
        ))
        .expect("the planning chat has its folder");
    let fresh = SessionId::try_from(mint_uuid_v7()).expect("a minted UUID is a session id");
    fixture
        .writer
        .write(vec![managed_folder_hold_statement(
            RepoMountId::new(&planning_mount).expect("a stored mount id"),
            planning,
            fresh,
        )])
        .await
        .expect("the fresh chat holds the planning chat's folder");
    record_hand_off(&fixture.writer, planning, fresh).await;
    fixture
        .creation
        .create_handed_off(hand_off_key(fresh))
        .await
        .expect("the fresh chat is born");
    let _seeding = RecordingSeeding::set_on(&fixture);

    let state = fixture
        .creation
        .finish_handed_off(hand_off_key(fresh))
        .await
        .expect("the hand-off finishes");

    assert_eq!(state, SessionState::Active);
    assert_eq!(
        fixture.text(&format!(
            "SELECT repo_mount_id FROM workspaces WHERE session_id = '{fresh}'"
        )),
        Some(planning_mount)
    );
    assert_eq!(fixture.count(MANAGED_MOUNTS), 1);
}

// Dies to a hand-off session finished outside the port (the left one bound or active), to the
// seed filter missing (the seeded one handed), and to the unborn hand-off skipped (not handed).
#[tokio::test]
async fn the_start_hands_each_unseeded_hand_off_to_the_port_and_finishes_none_itself() {
    let fixture = Fixture::new().await;
    let planning = fixture
        .creation
        .create(project_request(new_key(), None))
        .await
        .expect("the planning session is made")
        .session_id;
    let fresh_session = || SessionId::try_from(mint_uuid_v7()).expect("a minted UUID is an id");
    let (unborn, left, seeded) = (fresh_session(), fresh_session(), fresh_session());
    record_hand_off(&fixture.writer, planning, unborn).await;
    record_hand_off(&fixture.writer, planning, left).await;
    let seeded_hand_off = record_hand_off(&fixture.writer, planning, seeded).await;
    for born in [left, seeded] {
        fixture
            .creation
            .create_handed_off(hand_off_key(born))
            .await
            .expect("the fresh session is born");
    }
    let seeding = RecordingSeeding::set_on(&fixture);
    fixture
        .creation
        .finish_handed_off(hand_off_key(seeded))
        .await
        .expect("the seeded hand-off finishes");
    let seed = NewQueueItem {
        id: QueueItemId::try_from(mint_uuid_v7()).expect("a minted UUID is a queue item id"),
        session_id: seeded,
        body: QueueItemBody::PlanMessage {
            plan_message: PlanMessage {
                plan_id: seeded_hand_off.plan_id,
                kind: PlanMessageKind::Seed,
                source_session_id: Some(planning),
            },
            text: FreeFormText::new("Implement the plan.".to_owned()).expect("a message"),
        },
        target_run_id: RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id"),
        device_id: None,
        client_idempotency_key: Some(hand_off_key(seeded)),
        replaces_queue_item_id: None,
        now: WireInstant::now(),
    };
    fixture
        .writer
        .write(vec![insert_queue_item_statement(&seed)])
        .await
        .expect("the seed is queued");
    fixture.execute(&format!(
        "UPDATE queue_items SET state = 'admitted' WHERE session_id = '{seeded}'"
    ));

    fixture
        .creation
        .finish_stopped_creates()
        .await
        .expect("the start pass settles");

    let mut handed: Vec<SessionId> = seeding
        .calls()
        .into_iter()
        .filter(|(method, _, _)| *method == "finish_hand_off")
        .map(|(_, session_id, _)| session_id)
        .collect();
    handed.sort_by_key(ToString::to_string);
    let mut unseeded = vec![unborn, left];
    unseeded.sort_by_key(ToString::to_string);
    assert_eq!(handed, unseeded);
    assert_eq!(
        fixture.text(&format!("SELECT state FROM sessions WHERE id = '{left}'")),
        Some("provisioning".to_owned())
    );
    assert_eq!(
        fixture.count(&format!(
            "SELECT count(*) FROM workspaces WHERE session_id = '{left}'"
        )),
        0
    );
}

// Dies to the clone's attach handing the port no hand-off (the fresh session waits for the next
// start, provisioning) and to the project filter dropped (the chat's hand-off handed too).
#[tokio::test]
async fn a_clone_s_attach_hands_its_project_s_unseeded_hand_offs_to_the_port() {
    let fixture = Fixture::new().await;
    let planning = fixture
        .creation
        .create(project_request(new_key(), None))
        .await
        .expect("the planning session is made")
        .session_id;
    let planning_chat = fixture
        .creation
        .create(chat_request(new_key()))
        .await
        .expect("the planning chat is made")
        .session_id;
    let fresh_session = || SessionId::try_from(mint_uuid_v7()).expect("a minted UUID is an id");
    let (fresh, fresh_chat) = (fresh_session(), fresh_session());
    record_hand_off(&fixture.writer, planning, fresh).await;
    record_hand_off(&fixture.writer, planning_chat, fresh_chat).await;
    for born in [fresh, fresh_chat] {
        fixture
            .creation
            .create_handed_off(hand_off_key(born))
            .await
            .expect("the fresh session is born");
    }
    let seeding = RecordingSeeding::set_on(&fixture);
    fixture.start_cloning();
    let state = fixture
        .creation
        .finish_handed_off(hand_off_key(fresh))
        .await
        .expect("the finish waits for the clone");
    assert_eq!(state, SessionState::Provisioning);

    fixture.end_cloning();
    fixture
        .creation
        .clone_attached(ProjectId::new(PROJECT_ID).expect("a project id"))
        .await
        .expect("the clone's sessions and hand-offs are handed on");

    assert_eq!(
        seeding.calls(),
        vec![("finish_hand_off", fresh, Some("provisioning".to_owned()))]
    );
}
