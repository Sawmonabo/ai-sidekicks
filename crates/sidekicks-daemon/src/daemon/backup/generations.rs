//! Which backups stay once a run has written a new one: each of the seven newest days that holds a
//! backup keeps its newest, and each of the four newest weeks keeps its earliest day's, which is
//! its Monday's when that day holds one. Days and ISO weeks are the computer's own, in its time
//! zone. Every other backup is pruned.

use std::collections::{BTreeMap, HashSet};
use std::path::PathBuf;

use jiff::Timestamp;
use jiff::civil::Date;
use jiff::tz::TimeZone;

/// How many days keep their newest backup.
const DAILY_BACKUPS_KEPT: usize = 7;

/// How many weeks keep their earliest day's backup.
const WEEKLY_BACKUPS_KEPT: usize = 4;

/// One backup in the folder: its folder and when its manifest says it was taken.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct BackupGeneration {
    /// The backup's folder.
    pub(crate) folder: PathBuf,
    /// When it was taken.
    pub(crate) taken_at: Timestamp,
}

/// The folders of the backups in `backups` that no day or week keeps, read in `time_zone`.
pub(crate) fn backups_to_prune(backups: &[BackupGeneration], time_zone: &TimeZone) -> Vec<PathBuf> {
    // Each day's newest backup, by day.
    let mut dailies: BTreeMap<Date, &BackupGeneration> = BTreeMap::new();
    for backup in backups {
        let day = backup.taken_at.to_zoned(time_zone.clone()).date();
        dailies
            .entry(day)
            .and_modify(|daily| {
                if backup.taken_at > daily.taken_at {
                    *daily = backup;
                }
            })
            .or_insert(backup);
    }
    // Each week's earliest day's backup, by week; the days are read oldest first.
    let mut weeklies: BTreeMap<(i16, i8), &BackupGeneration> = BTreeMap::new();
    for (day, daily) in &dailies {
        let week = day.iso_week_date();
        weeklies.entry((week.year(), week.week())).or_insert(daily);
    }
    let kept: HashSet<&PathBuf> = dailies
        .values()
        .rev()
        .take(DAILY_BACKUPS_KEPT)
        .chain(weeklies.values().rev().take(WEEKLY_BACKUPS_KEPT))
        .map(|backup| &backup.folder)
        .collect();
    backups
        .iter()
        .filter(|backup| !kept.contains(&backup.folder))
        .map(|backup| backup.folder.clone())
        .collect()
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use jiff::Timestamp;
    use jiff::tz::TimeZone;

    use super::{BackupGeneration, backups_to_prune};

    fn backup(taken_at: &str) -> BackupGeneration {
        BackupGeneration {
            folder: PathBuf::from(taken_at),
            taken_at: taken_at
                .parse::<Timestamp>()
                .expect("the test's instant reads"),
        }
    }

    fn pruned(backups: &[BackupGeneration]) -> Vec<String> {
        let mut pruned: Vec<String> = backups_to_prune(backups, &TimeZone::UTC)
            .into_iter()
            .map(|folder| folder.display().to_string())
            .collect();
        pruned.sort();
        pruned
    }

    // Nine dailies from Monday the 5th to Tuesday the 13th keep the newest seven and both weeks'
    // Mondays, so only Tuesday the 6th goes; a day's older backup goes beside its newer one; a week
    // with no Monday keeps its earliest day. Killed by a weekly promoted from the week's newest
    // day, by a day keeping its oldest backup, and by a kept count off by one.
    #[test]
    fn nine_dailies_across_two_weeks_keep_the_newest_seven_and_each_monday() {
        let mut backups: Vec<BackupGeneration> = (5..=13)
            .map(|day| backup(&format!("2026-10-{day:02}T03:00:00Z")))
            .collect();
        backups.push(backup("2026-10-13T01:00:00Z"));

        assert_eq!(
            pruned(&backups),
            ["2026-10-06T03:00:00Z", "2026-10-13T01:00:00Z"]
        );

        // The week of the 28th of September holds Wednesday and Thursday only.
        let mut with_earlier_week = backups;
        with_earlier_week.push(backup("2026-09-30T03:00:00Z"));
        with_earlier_week.push(backup("2026-10-01T03:00:00Z"));

        assert_eq!(
            pruned(&with_earlier_week),
            [
                "2026-10-01T03:00:00Z",
                "2026-10-06T03:00:00Z",
                "2026-10-13T01:00:00Z"
            ]
        );
    }
}
