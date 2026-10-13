//! Which sessions each group's name row counts toward.

use std::collections::HashMap;

use crate::index::GroupMembers;

/// Every group's member sessions in the order ties break in, and each session's groups.
#[derive(Debug, Default)]
pub(crate) struct GroupMembership {
    members: HashMap<u64, Vec<u64>>,
    groups: HashMap<u64, Vec<u64>>,
}

impl GroupMembership {
    /// The membership of `groups`, each a group key with its member session keys in order; a group
    /// with no members is left out.
    pub(crate) fn from_groups(groups: &[GroupMembers]) -> GroupMembership {
        let members = groups
            .iter()
            .filter(|group| !group.session_keys.is_empty())
            .map(|group| (group.group_key, group.session_keys.clone()))
            .collect();
        GroupMembership::from_members(members)
    }

    /// This membership with the named groups' members replaced; a group given no members is
    /// forgotten.
    pub(crate) fn with_replacements(&self, replacements: &[GroupMembers]) -> GroupMembership {
        let mut members = self.members.clone();
        for group in replacements {
            if group.session_keys.is_empty() {
                members.remove(&group.group_key);
            } else {
                members.insert(group.group_key, group.session_keys.clone());
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
    pub(crate) fn members_of(&self, group: u64) -> &[u64] {
        self.members.get(&group).map_or(&[], Vec::as_slice)
    }

    /// The groups a session belongs to.
    pub(crate) fn groups_of(&self, session: u64) -> &[u64] {
        self.groups.get(&session).map_or(&[], Vec::as_slice)
    }
}
