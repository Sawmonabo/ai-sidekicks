# Git Notes Template

Git notes provide an audit trail of implementation decisions without cluttering commit messages or code comments.

---

## Why Git Notes?

| Feature | Git Notes | Commit Message | Code Comments | Separate Docs |
|---------|-----------|----------------|---------------|---------------|
| Linked to commit | Yes | Yes | No | No |
| Detailed content | Yes | Limited | Clutters code | Yes |
| Modifiable after commit | Yes | No | Changes hash | Yes |
| Doesn't change commit hash | Yes | N/A | N/A | N/A |
| Survives rebases | Configurable | Yes | Yes | N/A |

---

## Template

```bash
git notes add -m "$(cat <<'EOF'
## Subagent {{ID}} Implementation Notes

### Problem Analysis

For each requirement addressed:

#### Requirement 1: {{REQUIREMENT_NAME}}
- **Root Cause:** [What was wrong, with line numbers if applicable]
- **Impact:** [Effect on users/system]
- **Fix:** [Brief description of solution]

#### Requirement 2: {{REQUIREMENT_NAME}}
...

### Solutions Applied

1. **{{SOLUTION_COMPONENT_1}}**
   - Approach: [Description]
   - Location: [File path, function names]
   - Trade-off: [What was considered]

2. **{{SOLUTION_COMPONENT_2}}**
   ...

### Trade-offs Considered

| Decision | Alternative Considered | Why This Choice |
|----------|----------------------|-----------------|
| [Decision 1] | [Alternative] | [Reasoning] |
| [Decision 2] | [Alternative] | [Reasoning] |

### Testing Results

| Test Scenario | Result | Notes |
|---------------|--------|-------|
| {{TEST_1}} | PASS/FAIL | [Any notes] |
| {{TEST_2}} | PASS/FAIL | [Any notes] |
| Quality Check | PASS/FAIL | [Output summary] |

### Files Modified

- `{{FILE_1}}` - [Summary of changes]
- `{{FILE_2}}` - [Summary of changes]

### Lessons Learned

- [Insight 1]
- [Insight 2]
EOF
)" HEAD
```

---

## Sections Explained

### Problem Analysis

Document the root cause of each issue being fixed. Include:
- **Specific line numbers** where the problem existed
- **Why** the existing code was wrong (not just what)
- **User impact** to justify the fix priority

```markdown
#### Requirement 1: Settings not backed up
- **Root Cause:** Lines 97-120 only warn when settings differ but don't create backup
- **Impact:** Users lose their customizations when installing updates
- **Fix:** Added backup_settings() function that creates .ai-sidekicks.bak before copy
```

### Solutions Applied

Document each significant code change:
- **What** was done (approach)
- **Where** (file path, function name)
- **Why this approach** (trade-off rationale)

```markdown
1. **Manifest-based tracking**
   - Approach: Key-value text file (.ai-sidekicks-manifest)
   - Location: manifest_init(), manifest_write(), manifest_read() in install.sh
   - Trade-off: Chose text over JSON for simplicity - no jq dependency required
```

### Trade-offs Considered

Explicitly document alternatives you considered and rejected:

```markdown
| Decision | Alternative Considered | Why This Choice |
|----------|----------------------|-----------------|
| Key-value manifest | JSON manifest | Simpler parsing without jq |
| Atomic writes via temp+rename | Direct write | Prevents partial writes on interrupt |
| .ai-sidekicks.bak suffix | .bak.ai-sidekicks suffix | Sorts better, less likely to conflict |
```

### Testing Results

Provide pass/fail for each test with any relevant notes:

```markdown
| Test Scenario | Result | Notes |
|---------------|--------|-------|
| Install/uninstall cycle | PASS | Original files restored correctly |
| --project flag in unlink | PASS | Now targets project directory |
| Settings backup | PASS | Creates backup when content differs |
| Shellcheck compliance | PASS | No warnings |
| Legacy installation | PASS | Creates manifest from existing install |
```

### Lessons Learned

Capture insights for future work:

```markdown
- JSON parsing in pure bash is fragile - avoid without jq
- Always test --project flag independently from default behavior
- Dry-run mode should be mandatory for destructive operations
```

---

## Viewing Git Notes

```bash
# View notes for current commit
git notes show HEAD

# View notes in log
git log --notes -1

# View notes for specific commit
git notes show <commit-sha>
```

---

## Configuring Git Notes for Rebases

By default, git notes don't follow commits through rebases. To preserve them:

```bash
# Local configuration
git config notes.rewriteRef refs/notes/commits
git config notes.rewriteMode concatenate

# Or in .gitconfig
[notes]
    rewriteRef = refs/notes/commits
    rewriteMode = concatenate
```

---

## Example: Complete Git Note

```bash
git notes add -m "$(cat <<'EOF'
## Subagent C Implementation Notes

### Problem Analysis

#### Requirement 1: Uninstall doesn't restore original files
- **Root Cause:** Lines 126-144 in unlink_config() - copies from source instead of restoring .bak
- **Impact:** Users lose pre-installation configs permanently
- **Fix:** Added restore_backup() function that checks manifest and restores .ai-sidekicks.bak files

#### Requirement 2: --project flag ignored in unlink
- **Root Cause:** Lines 171-173 - $2 (--project) never passed to get_target_dir()
- **Impact:** Users cannot uninstall project-local configurations
- **Fix:** Added parse_args() function that properly handles --project in any position

#### Requirement 3: Orphaned backup files
- **Root Cause:** No cleanup mechanism - .bak files accumulate
- **Impact:** Disk space waste, user confusion about what to delete
- **Fix:** Manifest tracks all backups; restore_backup() removes .ai-sidekicks.bak after restore

#### Requirement 4: Settings not backed up
- **Root Cause:** Lines 97-120 only warn, don't backup
- **Impact:** Users lose settings customizations on update
- **Fix:** install_config() now calls create_backup() before copying settings.json

#### Requirement 5: No ownership identification
- **Root Cause:** Generic .bak suffix indistinguishable from user backups
- **Impact:** Users afraid to delete old backups
- **Fix:** Using .ai-sidekicks.bak suffix + manifest file for explicit tracking

### Solutions Applied

1. **Manifest-based tracking**
   - Approach: Key-value text file with version header
   - Location: manifest_*() functions in install.sh
   - Trade-off: Text format for simplicity over JSON (no jq needed)

2. **Argument parsing**
   - Approach: while loop with flag variables
   - Location: parse_args() function
   - Trade-off: More code but handles any flag order

3. **Dry-run support**
   - Approach: DRY_RUN variable checked before all destructive ops
   - Location: Throughout install.sh
   - Trade-off: Added complexity but critical for safety

4. **Migration command**
   - Approach: Detect legacy installs, create manifest, rename old backups
   - Location: migrate_legacy() function
   - Trade-off: One-time overhead for clean upgrade path

### Trade-offs Considered

| Decision | Alternative Considered | Why This Choice |
|----------|----------------------|-----------------|
| Key-value manifest | JSON manifest | No jq dependency, simpler parsing |
| parse_args() loop | Positional args | Handles flags in any order |
| .ai-sidekicks.bak suffix | UUID in filename | Human-readable, sortable |
| --dry-run flag | Automatic backup | User control over preview vs execute |

### Testing Results

| Test Scenario | Result | Notes |
|---------------|--------|-------|
| Basic install/uninstall | PASS | Original files restored |
| --unlink --project | PASS | Targets project directory |
| Settings backup | PASS | Creates backup when different |
| User backups preserved | PASS | Only touches .ai-sidekicks.bak |
| Legacy migration | PASS | Creates manifest, renames backups |
| Dry-run mode | PASS | No files modified |
| Verbose mode | PASS | Detailed output shown |
| Shellcheck | PASS | No warnings |

### Files Modified

- `install.sh` - Added 600+ lines: manifest functions, parse_args(), migrate_legacy(), dry-run support

### Lessons Learned

- Manifest format should be simple enough to parse without external tools
- Dry-run mode is essential for any destructive script
- Migration path is critical for backwards compatibility
- Testing must cover both user and project modes separately
EOF
)" HEAD
```

---

## Integration with Workflow

1. **Planning Phase**: No git notes (no commits)
2. **Implementation Phase**: Add git notes after final commit
3. **Merge Phase**: Add git notes documenting merge decisions
4. **Evaluation Phase**: Evaluators reference git notes for context
