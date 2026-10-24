//! The test of the calling thread's processor-time reader, which each platform's module supplies.

mod tests {
    use std::hint::black_box;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::thread;
    use std::time::{Duration, Instant};

    use crate::thread_cpu_time;

    // The processor time the busy loop runs until it has used.
    const BUSY_TIME: Duration = Duration::from_millis(50);

    // How long the busy loop may take under load before the test fails.
    const BUSY_DEADLINE: Duration = Duration::from_secs(30);

    // How long the measured thread sleeps while another thread burns processor time.
    const SLEEP_TIME: Duration = Duration::from_millis(300);

    // The most the clock may grow over the sleep: its own wake-up and the reads, well under the
    // sleep.
    const SLEEP_GROWTH_BOUND: Duration = Duration::from_millis(30);

    // The clock grows while the thread computes and stays still while it sleeps, though another
    // thread of the same process computes all through the sleep. Killed by a wall-clock reader and
    // by a reader of the whole process's processor time.
    #[test]
    fn the_clock_counts_only_the_calling_threads_own_work() {
        let busy_start = thread_cpu_time().expect("the clock reads");
        let deadline = Instant::now() + BUSY_DEADLINE;
        let mut spins: u64 = 0;
        while used_since(busy_start) < BUSY_TIME {
            assert!(
                Instant::now() < deadline,
                "the busy loop used no processor time"
            );
            spins = black_box(spins.wrapping_add(1));
        }

        let is_burning = Arc::new(AtomicBool::new(true));
        let burner_flag = Arc::clone(&is_burning);
        let burner = thread::spawn(move || {
            let mut spins: u64 = 0;
            while burner_flag.load(Ordering::Relaxed) {
                spins = black_box(spins.wrapping_add(1));
            }
        });
        let sleep_start = thread_cpu_time().expect("the clock reads");
        thread::sleep(SLEEP_TIME);
        let sleep_growth = used_since(sleep_start);
        is_burning.store(false, Ordering::Relaxed);
        burner.join().expect("the burner ends without a panic");

        assert!(
            sleep_growth < SLEEP_GROWTH_BOUND,
            "the clock grew {sleep_growth:?} over a {SLEEP_TIME:?} sleep"
        );
    }

    // The processor time the calling thread has used since the clock read `start`.
    fn used_since(start: Duration) -> Duration {
        thread_cpu_time()
            .expect("the clock reads")
            .checked_sub(start)
            .expect("the thread's clock never goes back")
    }
}
