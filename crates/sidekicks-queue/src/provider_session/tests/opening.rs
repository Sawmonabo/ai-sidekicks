//! A session's provider session opened: a resume, a restart or a create records the binding
//! its process runs under with its cursor open, a resume answered on the leg's own binding records
//! nothing, a process whose binding's row fails is closed, and a create whose provider is missing
//! posts the session's `providerMissing` notice.

use std::sync::Arc;
use std::sync::atomic::Ordering;

use futures::FutureExt as _;
use rstest::rstest;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_provider::driver::contract::error::DriverError;
use sidekicks_provider::driver::session_control::ProviderSessionHandle;
use sidekicks_provider::driver::test_registry::{first_provider, new_run_id};
use sidekicks_provider::runtime_binding::test_store::spawned_build;
use sidekicks_std::mutex_lock::lock;
use tokio::time::timeout;

use super::{Opening, WAIT, take_row, unregistered_provider, unresolvable_provider};
use crate::provider_session::errors::ProviderSessionError;
use crate::provider_session::test_opening::read_provider_missing_notices;

// Opening a session whose conversation an earlier daemon left resumes it, and a restart of its
// process brings it back the same way: each records the binding it minted on its predecessor's run,
// the binding's cursor open while the driver runs (the fixture's driver checks), and an opening
// also records its run's own binding, all under the one hold it took. Killed by the run's binding
// taking the session's lock again inside the open (the test times out), by the relaunch left
// unrecorded, and by a restart that opens no cursor before its process runs.
#[rstest]
#[case::open(false)]
#[case::restart(true)]
#[tokio::test]
async fn a_resume_or_a_restart_records_its_binding_under_its_own_hold(#[case] is_restart: bool) {
    let opening = Opening::new(Box::new(|_| {}), Box::new(|| {}), |_, _| {}).await;

    if is_restart {
        timeout(WAIT, opening.sessions.restart(opening.session_id))
            .await
            .expect("the restart takes its own lock once")
            .expect("the conversation comes back");
    } else {
        timeout(
            WAIT,
            opening.sessions.open(opening.session_id, opening.run_id),
        )
        .await
        .expect("the open takes its own lock once")
        .expect("the conversation resumes");
    }

    let bindings: Vec<(String, String)> = opening
        .database
        .reader()
        .prepare("SELECT id, run_id FROM runtime_bindings ORDER BY created_at, id")
        .expect("the test reads the bindings")
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .expect("the bindings read")
        .collect::<Result<_, _>>()
        .expect("each binding reads");
    assert_eq!(
        bindings.len(),
        if is_restart { 2 } else { 3 },
        "{bindings:?}"
    );
    assert!(
        bindings
            .iter()
            .any(|(id, bound_run_id)| id == opening.handed_id().as_str()
                && bound_run_id == opening.earlier_run_id.text().as_str()),
        "the relaunch is recorded on its predecessor's run: {bindings:?}"
    );
    assert!(
        is_restart
            || bindings
                .iter()
                .any(|(id, bound_run_id)| id != opening.predecessor_id.as_str()
                    && bound_run_id == opening.run_id.text().as_str()),
        "the opening run has its own binding: {bindings:?}"
    );
    assert_eq!(
        opening.following.followed(),
        vec![opening.session_id],
        "the idle sleep follows the opened session awake"
    );
}

// A session with no conversation yet is created: the cursor of the binding its process runs under
// is open before the create runs, and the binding's row names the build and the conversation the
// create reported; a failed create leaves no row and no cursor. Killed by the cursor opened after
// the create, by a failed create's cursor kept, by the row written before the create (a failed one
// keeps it), and by a version or handle the create did not report.
#[rstest]
#[case::created(true)]
#[case::refused(false)]
#[tokio::test]
async fn a_create_records_what_its_process_reported_and_a_failed_one_nothing(
    #[case] is_created: bool,
) {
    let opening = Opening::new(Box::new(|_| {}), Box::new(|| {}), |driver, watch| {
        let (epochs, handed_ids) = (Arc::clone(&watch.epochs), Arc::clone(&watch.handed_ids));
        driver.expect_create_session().returning(move |_params| {
            let binding_id = lock(&handed_ids)
                .last()
                .cloned()
                .expect("the create's process was handed a binding");
            assert!(
                lock(&epochs).binding(&binding_id).is_ok(),
                "the create's cursor is open before the process runs"
            );
            async move {
                if !is_created {
                    return Err(DriverError::Internal("the test's create fails".into()));
                }
                Ok(ProviderSessionHandle {
                    provider_session_id: "provider-session".to_owned(),
                    resume_handle: "conversation-2".to_owned(),
                    spawned_version: spawned_build("2.0.0", "/opt/provider/bin"),
                })
            }
            .boxed()
        });
    })
    .await;
    let reader = opening.database.reader();
    reader
        .execute("DELETE FROM runtime_bindings", [])
        .expect("the session is left with no conversation");

    let opened = opening
        .sessions
        .open(opening.session_id, opening.run_id)
        .await;

    let rows: Vec<(String, String, String)> = reader
        .prepare(
            "SELECT id, cli_version_raw, resume_handle FROM runtime_bindings WHERE run_id = ?1",
        )
        .expect("the test reads the bindings")
        .query_map([opening.run_id.text().as_str()], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })
        .expect("the bindings read")
        .collect::<Result<_, _>>()
        .expect("each binding reads");
    if is_created {
        assert!(opened.is_ok(), "{opened:?}");
        let [(id, version, handle)] = rows.as_slice() else {
            panic!("one binding is recorded: {rows:?}");
        };
        assert_eq!(
            (version.as_str(), handle.as_str()),
            ("2.0.0", "conversation-2")
        );
        let binding_id = RuntimeBindingId::new(id.clone()).expect("a stored binding id");
        assert!(
            lock(&opening.epochs).binding(&binding_id).is_ok(),
            "the binding's cursor is open"
        );
    } else {
        assert!(
            matches!(opened, Err(ProviderSessionError::Driver(_))),
            "{opened:?}"
        );
        assert_eq!(rows, Vec::new());
        assert!(
            lock(&opening.epochs).binding(&opening.handed_id()).is_err(),
            "a failed create's cursor is forgotten"
        );
    }
}

// A resume a process already up answers on the leg's own binding records no row, keeps the leg's
// cursor open and forgets the one minted for it. Killed by the answer's binding not compared with
// the minted one (its record fails on the leg's row and forgets the leg's cursor), and by the
// minted cursor kept.
#[tokio::test]
async fn a_resume_answered_on_the_legs_own_binding_records_nothing() {
    let opening = Opening::new(Box::new(|_| {}), Box::new(|| {}), |_, _| {}).await;
    *lock(&opening.came_up_on) = Some(opening.predecessor_id.clone());

    opening
        .sessions
        .open(opening.session_id, opening.run_id)
        .await
        .expect("the live process answers");

    let minted_id = opening.handed_id();
    let minted_rows: i64 = opening
        .database
        .reader()
        .query_row(
            "SELECT COUNT(*) FROM runtime_bindings WHERE id = ?1",
            [minted_id.as_str()],
            |row| row.get(0),
        )
        .expect("the bindings count");
    assert_eq!(minted_rows, 0);
    let epochs = lock(&opening.epochs);
    assert!(epochs.binding(&opening.predecessor_id).is_ok());
    assert!(epochs.binding(&minted_id).is_err());
}

// A process whose binding's row fails to write is closed, on a create and on a resume alike, so
// none runs under a binding with no row. Killed by either opening leaving the process running.
#[rstest]
#[case::create(true)]
#[case::resume(false)]
#[tokio::test]
async fn a_process_whose_binding_row_fails_is_closed(#[case] is_create: bool) {
    let opening = Opening::new(Box::new(|_| {}), Box::new(|| {}), |driver, watch| {
        let (handed_ids, store) = (Arc::clone(&watch.handed_ids), Arc::clone(&watch.store));
        driver.expect_create_session().returning(move |_params| {
            let binding_id = lock(&handed_ids)
                .last()
                .cloned()
                .expect("the create's process was handed a binding");
            let store = Arc::clone(&store);
            async move {
                take_row(&store, binding_id, new_run_id()).await;
                Ok(ProviderSessionHandle {
                    provider_session_id: "provider-session".to_owned(),
                    resume_handle: "conversation-2".to_owned(),
                    spawned_version: spawned_build("2.0.0", "/opt/provider/bin"),
                })
            }
            .boxed()
        });
    })
    .await;
    if is_create {
        opening
            .database
            .reader()
            .execute("DELETE FROM runtime_bindings", [])
            .expect("the session is left with no conversation");
    } else {
        opening.is_row_taken.store(true, Ordering::SeqCst);
    }

    let opened = opening
        .sessions
        .open(opening.session_id, opening.run_id)
        .await;

    assert!(
        matches!(opened, Err(ProviderSessionError::Cursor(_))),
        "{opened:?}"
    );
    assert_eq!(opening.closes.load(Ordering::SeqCst), 1);
}

// Why a create's provider fails it: no driver answers the provider, the driver finds no installed
// build of the bare command name, or the path the person typed does not run.
#[derive(Clone, Copy, Debug)]
enum CreateFailure {
    NoDriver,
    NotInstalled,
    TypedPathNotRunnable,
}

// A create whose provider no driver answers, or whose driver finds it not installed, posts one
// `providerMissing` notice naming the provider and the session's place, and still fails as it
// failed; a typed path that does not run is no missing provider and posts none. Killed by the
// notice posted twice for one start, by the place left out, by the start's own failure swallowed,
// and by the typed path posting.
#[rstest]
#[case::no_driver(CreateFailure::NoDriver)]
#[case::not_installed(CreateFailure::NotInstalled)]
#[case::typed_path(CreateFailure::TypedPathNotRunnable)]
#[tokio::test]
async fn a_create_whose_provider_is_missing_posts_one_notice_and_fails_as_it_failed(
    #[case] failure: CreateFailure,
) {
    let opening = Opening::new(Box::new(|_| {}), Box::new(|| {}), |driver, _| {
        driver.expect_create_session().returning(move |_params| {
            let is_typed_path = matches!(failure, CreateFailure::TypedPathNotRunnable);
            async move { Err(unresolvable_provider(is_typed_path)) }.boxed()
        });
    })
    .await;
    opening
        .database
        .reader()
        .execute("DELETE FROM runtime_bindings", [])
        .expect("the session is left with no conversation");
    if matches!(failure, CreateFailure::NoDriver) {
        *lock(&opening.provider) = Some(unregistered_provider());
    }

    let opened = opening
        .sessions
        .open(opening.session_id, opening.run_id)
        .await;

    let notices = read_provider_missing_notices(&opening.database.reader());
    match failure {
        CreateFailure::NoDriver => {
            assert!(
                matches!(
                    &opened,
                    Err(ProviderSessionError::Provider(refusal))
                        if refusal.code == RefusalCode::ProviderNotFound
                ),
                "{opened:?}"
            );
            assert_eq!(
                notices,
                vec![opening.provider_missing_notice(unregistered_provider())]
            );
        }
        CreateFailure::NotInstalled => {
            assert!(
                matches!(
                    &opened,
                    Err(ProviderSessionError::Driver(
                        DriverError::ExecutableUnresolvable(_)
                    ))
                ),
                "{opened:?}"
            );
            assert_eq!(
                notices,
                vec![opening.provider_missing_notice(first_provider())]
            );
        }
        CreateFailure::TypedPathNotRunnable => {
            assert!(
                matches!(
                    &opened,
                    Err(ProviderSessionError::Driver(
                        DriverError::ExecutableUnresolvable(_)
                    ))
                ),
                "{opened:?}"
            );
            assert_eq!(notices, Vec::new());
        }
    }
}
