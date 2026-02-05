# Git Notes Template for Implementation Subagents

This template was used by all implementation subagents (A, B, C, D) to document their work as git notes attached to their final commit.

---

## Template

```bash
git notes add -m "$(cat <<'EOF'
## Subagent [ID] Implementation Notes

### Issues Found

1. **Uninstall doesn't restore original files**
   - Root cause: Lines 126-144 in unlink_config()
   - The function copies from source instead of restoring .bak
   - Fix: [Describe your restore_backup() implementation]

2. **Project flag ignored in unlink**
   - Root cause: Lines 171-173 in main case statement
   - $2 (--project) never passed to get_target_dir
   - Fix: [Describe your argument parsing fix]

3. **Orphaned backup files**
   - Root cause: No cleanup mechanism for .bak files
   - Fix: [Describe your cleanup/manifest approach]

4. **Settings not backed up**
   - Root cause: Lines 97-120 only warn, don't backup
   - Fix: [Describe your settings backup implementation]

5. **No ownership identification**
   - Root cause: Generic .bak suffix indistinguishable from user backups
   - Fix: .ai-sidekicks.bak suffix + manifest file for explicit tracking

### Solutions Applied

1. **Manifest-based tracking**
   - Format: [JSON / Key-Value / Enhanced Key-Value]
   - Location: [Manifest file path]
   - Contents: [What the manifest tracks]

2. **Backup suffix convention**
   - Using `.ai-sidekicks.bak` suffix for clear ownership identification
   - User's existing `.bak` files are never touched

3. **Restore logic**
   - [Describe how restore_backup() works]
   - [Edge cases handled]

4. **Argument parsing**
   - [Describe parse_args() or similar function]
   - [How flags are processed in any order]

### Trade-offs Considered

| Decision | Alternative Considered | Why This Choice |
|----------|----------------------|-----------------|
| [Decision 1] | [Alternative] | [Reasoning] |
| [Decision 2] | [Alternative] | [Reasoning] |

### Testing Results

| Test Scenario | Result | Notes |
|--------------|--------|-------|
| Basic install/uninstall cycle | PASS/FAIL | [Any notes] |
| --unlink --project works | PASS/FAIL | [Any notes] |
| Orphan cleanup on uninstall | PASS/FAIL | [Any notes] |
| Settings backed up when different | PASS/FAIL | [Any notes] |
| User's manual backups preserved | PASS/FAIL | [Any notes] |
| Shellcheck compliance | PASS/FAIL | [Any notes] |
| Legacy installation handled | PASS/FAIL | [Any notes] |
EOF
)" HEAD
```

---

## Usage Instructions

### When to Add Git Notes

Add git notes **immediately after committing** your implementation:

```bash
# 1. Commit your changes
git add install.sh
git commit -m "fix(install): implement manifest-based backup/restore"

# 2. Add git notes with your documentation
git notes add -m "$(cat <<'EOF'
[Your filled-in template here]
EOF
)" HEAD
```

### Viewing Git Notes

```bash
# View notes for current commit
git notes show HEAD

# View notes in log
git log --notes -1
```

---

## Why Git Notes?

| Feature | Git Notes | Commit Message | Separate File |
|---------|-----------|----------------|---------------|
| Linked to commit | Yes | Yes | No |
| Detailed content | Yes | Limited | Yes |
| Modifiable after commit | Yes | No | Yes |
| Doesn't change commit hash | Yes | N/A | N/A |
