//! Which sessions each group's name row counts toward.

use std::collections::HashMap;

/// Every group's member sessions in the order ties break in, and each session's groups.
#[derive(Debug, Default)]
pub struct GroupMembership {
    members: HashMap<u64, Vec<u64>>,
    groups: HashMap<u64, Vec<u64>>,
}

impl GroupMembership {
    /// The membership of `groups`, each a group key with its member session keys in order; a group
    /// with no members is left out.
    pub fn from_groups(groups: impl IntoIterator<Item = (u64, Vec<u64>)>) -> GroupMembership {
        let members = groups
            .into_iter()
            .filter(|(_, sessions)| !sessions.is_empty())
            .collect();
        GroupMembership::from_members(members)
    }

    /// This membership with the named groups' members replaced; a group given no members is
    /// forgotten.
    pub fn with_replacements(&self, replacements: Vec<(u64, Vec<u64>)>) -> GroupMembership {
        let mut members = self.members.clone();
        for (group, sessions) in replacements {
            if sessions.is_empty() {
                members.remove(&group);
            } else {
                members.insert(group, sessions);
            }
        }
        GroupMembership::from_members(members)
    }

    fn from_members(members: HashMap<u64, Vec<u64>>) -> GroupMembership {
        let mut groups: HashMap<u64, Vec<u64>> = HashMap::new();
        for (group, sessions) in &members {
            for session in sessions {
                groups.entry(*session).or_default().push(*group);
            }
        }
        GroupMembership { members, groups }
    }

    /// The group's member sessions in order; none for a group the membership does not hold.
    pub fn members_of(&self, group: u64) -> &[u64] {
        self.members.get(&group).map_or(&[], Vec::as_slice)
    }

    /// The groups a session belongs to.
    pub fn groups_of(&self, session: u64) -> &[u64] {
        self.groups.get(&session).map_or(&[], Vec::as_slice)
    }
}
