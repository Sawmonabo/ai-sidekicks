//! When a paused shell's read loop reads anyway. Where a paused read holds the program's input back
//! too, the loop reads on while a write waits for the terminal, and after the terminal takes one
//! until a read finds the output empty: a write the terminal took may still wait in the system's
//! own pipe until the console, no longer blocked on its full output, reads it.

/// Whether a paused loop holds its read now, and the write that keeps it reading.
pub(super) struct PausedRead {
    does_hold_input: bool,
    /// Set by each write the terminal takes and cleared by the next read that finds the output
    /// empty; both run on the loop, so no write lands between that read's start and the clear.
    has_unconfirmed_write: bool,
}

impl PausedRead {
    /// The rule for a system where a paused read holds input back exactly when `does_hold_input`.
    pub(super) fn new(does_hold_input: bool) -> Self {
        Self {
            does_hold_input,
            has_unconfirmed_write: false,
        }
    }

    /// Records that the terminal took a write.
    pub(super) fn wrote(&mut self) {
        self.has_unconfirmed_write = true;
    }

    /// Records that a read found the output empty, which confirms every write taken before it.
    pub(super) fn found_output_empty(&mut self) {
        self.has_unconfirmed_write = false;
    }

    /// Whether the loop holds its read: only while paused, and never where a paused read would
    /// hold the input back while a write waits or one the terminal took is unconfirmed.
    pub(super) fn is_read_held(&self, is_paused: bool, is_write_waiting: bool) -> bool {
        is_paused && !(self.does_hold_input && (is_write_waiting || self.has_unconfirmed_write))
    }
}

#[cfg(test)]
mod tests {
    use super::PausedRead;

    #[test]
    fn a_paused_read_that_holds_input_reads_on_until_a_read_after_the_write_finds_nothing() {
        let mut paused = PausedRead::new(true);
        assert!(
            paused.is_read_held(true, false),
            "a quiet pause holds the read"
        );
        assert!(!paused.is_read_held(true, true), "a waiting write reads on");

        // The terminal took the write, which may still wait in the system's pipe.
        paused.wrote();
        assert!(
            !paused.is_read_held(true, false),
            "an unconfirmed write reads on"
        );
        paused.found_output_empty();
        assert!(
            paused.is_read_held(true, false),
            "an empty read confirms it"
        );

        // Where a paused read holds no input back, the pause holds whatever waits.
        let mut paused = PausedRead::new(false);
        paused.wrote();
        assert!(paused.is_read_held(true, true));
        assert!(!paused.is_read_held(false, false), "a running loop reads");
    }
}
