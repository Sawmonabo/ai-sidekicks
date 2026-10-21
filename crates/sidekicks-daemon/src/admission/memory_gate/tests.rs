use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use tokio::sync::watch;
use tokio::time::timeout;

use super::{
    AdmissionOutcome, AdmissionWork, MemoryAdmissionState, MemoryGate, MemoryGateFigures,
    ProviderStartEstimate,
};

const MEBIBYTE: u64 = 1024 * 1024;
const GIBIBYTE: u64 = 1024 * MEBIBYTE;
/// The headroom of a machine with under 5 GiB of physical memory.
const HEADROOM: u64 = GIBIBYTE;
const PROVIDER_START: ProviderStartEstimate = ProviderStartEstimate {
    provider_id: "provider",
    is_conversation: false,
    starting_bytes: 288 * MEBIBYTE,
};

/// A gate on a machine whose available memory the case sets, and whose every process peaked at
/// `peak_bytes`.
fn open_gate(peak_bytes: u64) -> (MemoryGate, Arc<AtomicU64>) {
    let available = Arc::new(AtomicU64::new(0));
    let reading = Arc::clone(&available);
    let gate = MemoryGate::new(
        MemoryGateFigures {
            physical_memory_bytes: 4 * GIBIBYTE,
            quick_thread_bytes: 0,
            ingest_worker_bytes: 0,
        },
        Arc::new(move || Ok(reading.load(Ordering::SeqCst))),
        Arc::new(move |_process_id| Ok(Some(peak_bytes))),
    );
    (gate, available)
}

fn ingest(file_bytes: u64) -> AdmissionWork {
    AdmissionWork::Ingest {
        file_bytes,
        picture_pixels: 0,
    }
}

fn quick(budget_bytes: u64) -> AdmissionWork {
    AdmissionWork::QuickCode {
        budget_bytes,
        input_bytes: 0,
        output_max_bytes: 0,
        workflow_node_key: "workflow-quick".to_owned(),
    }
}

fn provider(workflow_node_key: &str) -> AdmissionWork {
    AdmissionWork::Provider {
        start: PROVIDER_START,
        workflow_node_key: Some(workflow_node_key.to_owned()),
    }
}

/// Whether the wait ends in admission within `within`, on the paused clock.
async fn is_admitted_within(
    mut admitted: watch::Receiver<Option<AdmissionOutcome>>,
    within: Duration,
) -> bool {
    timeout(within, admitted.wait_for(Option::is_some))
        .await
        .is_ok_and(|outcome| {
            *outcome.expect("the gate outlives the wait") == Some(AdmissionOutcome::Admitted)
        })
}

#[tokio::test(start_paused = true)]
async fn the_head_alone_is_weighed_against_memory_and_no_room_still_admits_one() {
    let (gate, available) = open_gate(0);
    let first = gate.enqueue(ingest(100 * MEBIBYTE));
    assert!(
        is_admitted_within(first.admitted(), Duration::from_millis(1)).await,
        "with nothing admitted the head starts on a full machine"
    );
    let large = gate.enqueue(ingest(500 * MEBIBYTE));
    let small = gate.enqueue(quick(50 * MEBIBYTE));
    assert!(!is_admitted_within(large.admitted(), Duration::from_secs(3)).await);
    assert_eq!(
        small.state(),
        MemoryAdmissionState::Waiting,
        "the line keeps its order"
    );

    available.store(HEADROOM + 600 * MEBIBYTE, Ordering::SeqCst);
    assert!(
        is_admitted_within(large.admitted(), Duration::from_millis(1_100)).await,
        "the waiting head is weighed again a second later"
    );
    assert!(!is_admitted_within(small.admitted(), Duration::from_secs(3)).await);
    first.park().expect("an admitted entry parks");
    assert!(
        is_admitted_within(small.admitted(), Duration::from_millis(1)).await,
        "a park frees its reservation at once"
    );
}

// Killed by a spacing kept after the start that set it ended.
#[tokio::test(start_paused = true)]
async fn an_ended_estimated_start_spaces_no_later_one() {
    let (gate, available) = open_gate(0);
    available.store(64 * GIBIBYTE, Ordering::SeqCst);
    let first = gate.enqueue(provider("workflow-node-1"));
    assert!(is_admitted_within(first.admitted(), Duration::from_millis(1)).await);
    drop(first);
    let second = gate.enqueue(provider("workflow-node-2"));
    assert!(is_admitted_within(second.admitted(), Duration::from_millis(1)).await);
}

#[tokio::test(start_paused = true)]
async fn estimated_starts_are_spaced_and_a_node_reserves_the_peak_it_reached() {
    let (gate, available) = open_gate(5 * GIBIBYTE);
    available.store(64 * GIBIBYTE, Ordering::SeqCst);
    let first = gate.enqueue(provider("workflow-node-1"));
    assert!(is_admitted_within(first.admitted(), Duration::from_millis(1)).await);
    let second = gate.enqueue(provider("workflow-node-2"));
    assert!(!is_admitted_within(second.admitted(), Duration::from_millis(1_400)).await);
    assert!(is_admitted_within(second.admitted(), Duration::from_millis(200)).await);
    let quick_step = gate.enqueue(quick(50 * MEBIBYTE));
    assert!(
        is_admitted_within(quick_step.admitted(), Duration::from_millis(1)).await,
        "a start whose size is known waits for no spacing"
    );

    first
        .observe_process_peak(4_182)
        .await
        .expect("the peak is read");
    first.release();
    available.store(
        HEADROOM + 288 * MEBIBYTE + 50 * MEBIBYTE + GIBIBYTE,
        Ordering::SeqCst,
    );
    let again = gate.enqueue(provider("workflow-node-1"));
    assert!(
        !is_admitted_within(again.admitted(), Duration::from_secs(3)).await,
        "the node reserves the 5 GiB it reached, not the 288 MiB estimate"
    );
    available.fetch_add(4 * GIBIBYTE, Ordering::SeqCst);
    assert!(is_admitted_within(again.admitted(), Duration::from_millis(1_100)).await);
}
