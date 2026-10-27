//! Parallel steps that all settle before anyone cleans up after them, so no step still writes once
//! the cleanup starts: the caller joins them (`join!`, `join_all`) and folds the outcomes here.

use std::fmt::{self, Display};

/// The failures of steps that all settled: the one failure as it came, or every failure with the
/// operation they belonged to.
#[derive(Debug, thiserror::Error)]
pub(crate) enum SettleFailures<Failure> {
    /// The one step that failed.
    #[error(transparent)]
    One(Failure),
    /// Every step that failed, in the steps' order.
    #[error("{operation} failed: {}", DescribeEach(.failures))]
    Many {
        /// What the steps were doing, as a log line names it.
        operation: &'static str,
        /// Each failure, kept whole.
        failures: Vec<Failure>,
    },
}

/// The outcomes of steps joined together, each a `Result` of one failure type, which
/// [`settle_all`] folds into their values or their failures.
pub(crate) trait SettledOutcomes {
    /// Every step's value, in the steps' order.
    type Values;
    /// The failure each step may end with.
    type Failure;

    /// Splits the outcomes into the values, when every step succeeded, or every failure.
    fn into_values(self) -> Result<Self::Values, Vec<Self::Failure>>;
}

impl<Value, Failure> SettledOutcomes for Vec<Result<Value, Failure>> {
    type Values = Vec<Value>;
    type Failure = Failure;

    fn into_values(self) -> Result<Vec<Value>, Vec<Failure>> {
        let mut values = Vec::with_capacity(self.len());
        let mut failures = Vec::new();
        for outcome in self {
            match outcome {
                Ok(value) => values.push(value),
                Err(failure) => failures.push(failure),
            }
        }
        if failures.is_empty() {
            Ok(values)
        } else {
            Err(failures)
        }
    }
}

impl<First, Second, Failure> SettledOutcomes for (Result<First, Failure>, Result<Second, Failure>) {
    type Values = (First, Second);
    type Failure = Failure;

    fn into_values(self) -> Result<(First, Second), Vec<Failure>> {
        match self {
            (Ok(first), Ok(second)) => Ok((first, second)),
            (first, second) => Err([first.err(), second.err()].into_iter().flatten().collect()),
        }
    }
}

impl<First, Second, Third, Failure> SettledOutcomes
    for (
        Result<First, Failure>,
        Result<Second, Failure>,
        Result<Third, Failure>,
    )
{
    type Values = (First, Second, Third);
    type Failure = Failure;

    fn into_values(self) -> Result<(First, Second, Third), Vec<Failure>> {
        match self {
            (Ok(first), Ok(second), Ok(third)) => Ok((first, second, third)),
            (first, second, third) => Err([first.err(), second.err(), third.err()]
                .into_iter()
                .flatten()
                .collect()),
        }
    }
}

/// Folds the outcomes of steps that have all settled: each value in order, or the one failure, or
/// every failure in [`SettleFailures::Many`] named by `operation`.
pub(crate) fn settle_all<Outcomes: SettledOutcomes>(
    outcomes: Outcomes,
    operation: &'static str,
) -> Result<Outcomes::Values, SettleFailures<Outcomes::Failure>> {
    outcomes.into_values().map_err(|mut failures| {
        if failures.len() == 1 {
            SettleFailures::One(failures.remove(0))
        } else {
            SettleFailures::Many {
                operation,
                failures,
            }
        }
    })
}

/// Failures written one after another, `; ` between them, for a message that names every cause.
pub(crate) struct DescribeEach<'a, Failure>(
    /// The failures, in the order they are written.
    pub(crate) &'a [Failure],
);

impl<Failure: Display> Display for DescribeEach<'_, Failure> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        for (index, failure) in self.0.iter().enumerate() {
            if index > 0 {
                formatter.write_str("; ")?;
            }
            write!(formatter, "{failure}")?;
        }
        Ok(())
    }
}
