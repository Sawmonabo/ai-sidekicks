//! The sliding window over a real account file: the shared scenario table, and the cleanup that
//! leaves nothing counted once every window has passed.

use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};
use std::time::Duration;

use jiff::Timestamp;
use serde::Deserialize;
use sidekicks_control_plane::rate_limit::enforcement_pipeline::{
    AccountFileAdmission, AdmissionCheck,
};
use sidekicks_control_plane::rate_limit::limiter::{
    RateLimitCheckRequest, RateLimitEndpointGroup, check,
};

use crate::helpers::create_account_file;

/// Any instant works as a scenario's start; this one is fixed so a failure reads the same twice.
const START_MS: i64 = 1_900_000_000_000;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Scenarios {
    scenarios: Vec<Scenario>,
}

#[derive(Deserialize)]
struct Scenario {
    name: String,
    endpoint: RateLimitEndpointGroup,
    steps: Vec<Step>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Step {
    at_ms: i64,
    identity: String,
    times: u32,
    allowed: bool,
    remaining: u32,
    reset_at_ms: i64,
}

#[test]
fn the_window_answers_every_scenario() {
    let table: Scenarios =
        serde_json::from_str(include_str!("../fixtures/rate_limiter_scenarios.json"))
            .expect("the scenario table reads");
    for scenario in table.scenarios {
        let name = scenario.name;
        let account = create_account_file();
        let connection = account
            .connection
            .lock()
            .expect("no test panicked holding the file");
        for step in scenario.steps {
            let now = Timestamp::from_millisecond(START_MS + step.at_ms).unwrap();
            let request = RateLimitCheckRequest {
                identity: step.identity.clone(),
                endpoint: scenario.endpoint,
            };
            let mut last = None;
            for _ in 0..step.times {
                let answer = check(&*connection, &request, now).unwrap();
                assert_eq!(answer.allowed, step.allowed, "{name}: at {} ms", step.at_ms);
                last = Some(answer);
            }
            let last = last.unwrap();
            assert_eq!(
                (last.remaining, last.reset_at.unix_millisecond().unwrap()),
                (step.remaining, START_MS + step.reset_at_ms),
                "{name}: at {} ms",
                step.at_ms
            );
        }
    }
}

static CLOCK_MS: AtomicI64 = AtomicI64::new(START_MS);

fn read_test_clock() -> Result<Timestamp, jiff::Error> {
    Timestamp::from_millisecond(CLOCK_MS.load(Ordering::SeqCst))
}

async fn count(admission: &AccountFileAdmission, identity: &str) {
    let request = RateLimitCheckRequest {
        identity: identity.to_owned(),
        endpoint: RateLimitEndpointGroup::AuthEndpoint,
    };
    let answer = admission
        .check_admission(request, None)
        .await
        .expect("the account file counts");
    assert!(answer.allowed);
}

#[tokio::test(start_paused = true)]
async fn nothing_counted_outlives_its_window() {
    let account = create_account_file();
    let admission = AccountFileAdmission::new(Arc::clone(&account.connection), read_test_clock);
    // The second count finds the first one's task running and starts none.
    count(&admission, "198.51.100.7").await;
    count(&admission, "203.0.113.9").await;
    assert_eq!(account.count_held_requests(), 2);

    // A count after the task has ended starts another.
    for round in 1..=2 {
        CLOCK_MS.store(START_MS + round * 60_000, Ordering::SeqCst);
        tokio::time::sleep(Duration::from_secs(61)).await;
        assert_eq!(
            account.count_held_requests(),
            0,
            "round {round}: every window has passed"
        );
        // The test and the admission hold the file; a cleanup task still waiting would hold a
        // third.
        assert_eq!(
            Arc::strong_count(&account.connection),
            2,
            "round {round}: no cleanup task is left"
        );
        if round == 1 {
            count(&admission, "198.51.100.7").await;
            assert_eq!(account.count_held_requests(), 1);
        }
    }
}
