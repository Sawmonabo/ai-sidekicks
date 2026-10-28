//! The live projects list's tests: a burst of changes read once, an unchanged list sent never, and
//! a failed read ending the subscription so the next one reads the rows again.

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures::FutureExt as _;
use futures::future::BoxFuture;
use rusqlite::{Connection, params};
use serde_json::json;
use sidekicks_contracts::project::{ProjectId, ProjectList};
use sidekicks_contracts::repo::mount::ExecutionMode;
use sidekicks_contracts::session::directory::SessionActivity;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_ipc::registry::HandlerError;
use sidekicks_ipc::stream::feed::Feed as _;
use sidekicks_ipc::stream::latest_value::LatestValueFeed;
use sidekicks_std::mutex_lock::lock;
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
use sidekicks_store::database::schema::session_directory::insert_session_row;
use sidekicks_store::database::writer::test_file::{TestDatabase, test_envelope, test_session_id};
use sidekicks_store::events::log_service::EventLogAppendOptions;
use sidekicks_store::events::log_service::test_fixture::{TestLog, open_log};
use tokio::time::timeout;

use crate::git::worktree::schema::schema_parts;
use crate::project::list_feed::ProjectListFeed;
use crate::project::records::{
    PROJECT_RECORDS_STATEMENT_CAPACITY, ProjectRecords, ProjectSessionActivity, ProjectSessionFacts,
};
use crate::project::test_doubles::OpenGate;
use crate::test_rows::PARENT_ROWS_AT;

// Long enough that a read the feed was going to make has made it.
const QUIET: Duration = Duration::from_millis(200);
const WAIT: Duration = Duration::from_secs(10);

// The session directory's activity as the test sets it, counting each read and failing on demand.
#[derive(Default)]
struct CountedActivity {
    reads: AtomicUsize,
    is_failing: AtomicBool,
    facts: Mutex<Vec<ProjectSessionFacts>>,
}

impl ProjectSessionActivity for CountedActivity {
    fn read_session_facts(
        &self,
        _reader: &Connection,
        project_ids: Option<&[ProjectId]>,
    ) -> rusqlite::Result<Vec<ProjectSessionFacts>> {
        self.reads.fetch_add(1, Ordering::SeqCst);
        if self.is_failing.load(Ordering::SeqCst) {
            return Err(rusqlite::Error::InvalidQuery);
        }
        Ok(lock(&self.facts)
            .iter()
            .filter(|facts| project_ids.is_none_or(|ids| ids.contains(&facts.project_id)))
            .cloned()
            .collect())
    }
}

impl CountedActivity {
    fn reads(&self) -> usize {
        self.reads.load(Ordering::SeqCst)
    }

    fn set(&self, project_id: ProjectId, session_id: SessionId, activity: SessionActivity) {
        *lock(&self.facts) = vec![ProjectSessionFacts {
            project_id,
            session_id,
            activity,
        }];
    }
}

// A project and one of its sessions, the session found in it through its create request.
fn insert_project_session(connection: &Connection, project_id: ProjectId, session_id: SessionId) {
    connection
        .execute(
            "INSERT INTO projects (id, name, slug, folder_path, state, setup, created_at, \
             updated_at) VALUES (?1, 'app', ?1, '/repos/app', 'active', \
             '{\"filesToCopy\":[],\"commands\":[]}', ?2, ?2)",
            params![project_id.text().as_str(), PARENT_ROWS_AT],
        )
        .expect("the test stores a project");
    insert_session_row(connection, session_id.text().as_str(), None, None);
    connection
        .execute(
            "INSERT INTO session_create_requests (client_idempotency_key, session_id, project_id, \
             execution_mode) VALUES (?1, ?1, ?2, ?3)",
            params![
                session_id.text().as_str(),
                project_id.text().as_str(),
                <&'static str>::from(ExecutionMode::ProvisionedWorktree)
            ],
        )
        .expect("the test stores the session's create request");
}

async fn append_archived(log: &TestLog, session_id: SessionId) {
    let event = serde_json::from_value(json!({
        "type": "session.archived",
        "payload": { "sessionId": session_id, "newState": "archived" },
    }))
    .expect("the test writes a session.archived event");
    log.service
        .append(
            test_envelope(session_id, &event),
            EventLogAppendOptions::default(),
        )
        .await
        .expect("the event is appended");
}

type ProjectListStream = LatestValueFeed<ProjectList, Box<dyn FnOnce() + Send>>;

async fn open_list(feed: &Arc<ProjectListFeed>) -> Result<ProjectListStream, HandlerError> {
    let feed = Arc::clone(feed);
    LatestValueFeed::open(move |outlet| async move { feed.open(outlet).await }).await
}

fn running_count(list: &ProjectList) -> SafeInt<0> {
    list.projects
        .first()
        .expect("the list holds the project")
        .session_tally
        .running
}

// Kills a read per change (a fourth read reaches the third hold), a send of an unchanged list, a
// failed read that leaves its subscription open, and a held list kept past a failure (the reopen
// would answer without reading).
#[tokio::test]
async fn a_burst_reads_once_an_unchanged_list_is_not_sent_and_a_failed_read_ends_the_list() {
    let database = TestDatabase::new(schema_parts());
    let log = open_log(&database, None).await;
    let project_id = ProjectId::try_from(mint_uuid_v7()).expect("a minted UUID is a project id");
    let session_id = test_session_id();
    insert_project_session(&database.reader(), project_id, session_id);
    let activity = Arc::new(CountedActivity::default());
    activity.set(project_id, session_id, SessionActivity::Idle);
    let records = Arc::new(ProjectRecords::new(
        Arc::new(DatabaseReadPool::new(
            database.path(),
            PROJECT_RECORDS_STATEMENT_CAPACITY,
        )),
        Arc::clone(&activity) as Arc<dyn ProjectSessionActivity>,
    ));
    let feed = Arc::new(ProjectListFeed::new(records, &log.followers));
    let gate = OpenGate;

    let mut list = open_list(&feed).await.expect("the list opens");
    let opened = list
        .next(&gate)
        .await
        .expect("the list reads")
        .expect("a list comes");
    assert_eq!(
        running_count(&opened),
        SafeInt::new(0).expect("zero is a safe integer")
    );
    assert_eq!(activity.reads(), 1);

    // The first change is held after its take, so the burst waits behind it.
    let first_hold = feed.shared.burst_read_pause.arm();
    let burst_hold = feed.shared.burst_read_pause.arm();
    feed.refresh(&[project_id]);
    first_hold.reached.await.expect("the first change is taken");
    activity.set(project_id, session_id, SessionActivity::Running);
    for _ in 0..3 {
        append_archived(&log, session_id).await;
    }
    feed.refresh(&[project_id]);
    first_hold.release.send(()).expect("the first read is held");

    let changed = timeout(WAIT, list.next(&gate))
        .await
        .expect("the changed list comes")
        .expect("the list reads")
        .expect("a list comes");
    assert_eq!(
        running_count(&changed),
        SafeInt::new(1).expect("one is a safe integer")
    );
    timeout(WAIT, burst_hold.reached)
        .await
        .expect("the burst is taken")
        .expect("the burst is held");
    let after_burst_hold = feed.shared.burst_read_pause.arm();
    burst_hold.release.send(()).expect("the burst read is held");
    let mut after_burst_reached = after_burst_hold.reached;
    assert!(
        timeout(QUIET, &mut after_burst_reached).await.is_err(),
        "three events and a refresh read once"
    );
    assert_eq!(activity.reads(), 3);
    assert!(
        list.next(&gate).now_or_never().is_none(),
        "an unchanged list is not sent"
    );

    activity.is_failing.store(true, Ordering::SeqCst);
    feed.refresh(&[project_id]);
    after_burst_reached
        .await
        .expect("the failing read is taken");
    after_burst_hold
        .release
        .send(())
        .expect("the failing read is held");
    assert!(
        timeout(WAIT, list.next(&gate))
            .await
            .expect("the stream answers")
            .is_err(),
        "a failed read ends the subscription"
    );

    activity.is_failing.store(false, Ordering::SeqCst);
    let reads_before_reopen = activity.reads();
    let mut reopened = open_list(&feed).await.expect("the list opens again");
    let reread = reopened
        .next(&gate)
        .await
        .expect("the list reads")
        .expect("a list comes");
    assert_eq!(
        activity.reads(),
        reads_before_reopen + 1,
        "the reopen reads the rows"
    );
    assert_eq!(
        running_count(&reread),
        SafeInt::new(1).expect("one is a safe integer")
    );
}
