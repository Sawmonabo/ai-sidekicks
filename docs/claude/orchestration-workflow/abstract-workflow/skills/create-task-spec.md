# Skill: create-task-spec

A skill that helps create task specification files for the orchestration workflow.

---

## Skill Definition

```yaml
name: create-task-spec
description: |
  Create a task specification file formatted for multi-agent orchestration.
  Guides you through defining requirements, constraints, and evaluation criteria.

  Usage:
  - /create-task-spec <output-path>
  - /create-task-spec --interactive

  Examples:
  - /create-task-spec .claude/tasks/api-refactor.md
  - /create-task-spec ./my-task.md --interactive

version: "1.0.0"
author: "ai-sidekicks"
tags:
  - task-creation
  - orchestration
  - specification

inputs:
  output_path:
    type: string
    required: true
    description: Path where task spec will be written
  interactive:
    type: boolean
    default: true
    description: Guide through creation interactively
```

---

## Skill Implementation

```markdown
<skill-implementation>
## Task Specification Creator

I'll help you create a task specification formatted for multi-agent orchestration.

### Information Needed

1. **Task Name**: Brief name for this task
2. **Context**: Background information and project details
3. **Problem Statement**: What needs to be solved
4. **Requirements**: Numbered list of requirements
5. **Constraints**: Technical or process constraints
6. **Success Criteria**: How we know when it's done
7. **Evaluation Criteria** (optional): Custom weights for evaluation

### Template Structure

```markdown
# Task: {{task_name}}

## Context

{{context}}

## Problem Statement

{{problem_statement}}

## Requirements

1. {{requirement_1}}
2. {{requirement_2}}
3. {{requirement_3}}

## Constraints

- {{constraint_1}}
- {{constraint_2}}

## Success Criteria

- [ ] {{criterion_1}}
- [ ] {{criterion_2}}
- [ ] {{criterion_3}}

## Evaluation Criteria

| Criterion | Weight | Description |
|-----------|--------|-------------|
| {{criterion_name}} | {{weight}}% | {{description}} |

## Research Guidance (Optional)

Subagents may research:
- {{topic_1}}
- {{topic_2}}

Use official documentation only.

## Output Paths

- Plans: `.claude/tmp/plans/`
- Implementations: `.claude/tmp/worktrees/`
- Reports: `.claude/tmp/reports/`
```

### Interactive Mode

{{#if interactive}}
Let me ask you some questions to build your task specification:

1. What is the name of this task?
2. What's the context/background?
3. What problem needs to be solved?
4. What are the specific requirements? (I'll help you number them)
5. What constraints should subagents follow?
6. How will we know when the task is complete?
7. Do you want custom evaluation criteria, or use defaults?
{{/if}}

After gathering information, I'll write the specification to: `{{output_path}}`
</skill-implementation>
```

---

## Example Output

Running `/create-task-spec .claude/tasks/auth-system.md` might produce:

```markdown
# Task: Implement Authentication System

## Context

The application currently has no authentication. Users can access all endpoints without credentials. We need to add a secure authentication system that supports both session-based and token-based auth.

## Problem Statement

Implement a complete authentication system including:
- User registration and login
- Session management OR JWT tokens
- Password hashing and validation
- Protected route middleware

## Requirements

1. **User Registration**
   - Email validation
   - Password strength requirements
   - Duplicate email prevention

2. **User Login**
   - Email/password authentication
   - Rate limiting for failed attempts
   - Session or token creation

3. **Session/Token Management**
   - Secure token generation
   - Expiration handling
   - Refresh mechanism

4. **Password Security**
   - bcrypt hashing
   - Minimum 12 characters
   - Breach database checking (optional)

5. **Route Protection**
   - Middleware for protected routes
   - Role-based access (admin/user)
   - Graceful unauthorized responses

## Constraints

- Must work with existing Express.js setup
- No external auth providers (OAuth2 out of scope)
- Must pass security audit requirements
- Must maintain backwards compatibility with existing user table

## Success Criteria

- [ ] Users can register with email/password
- [ ] Users can login and receive session/token
- [ ] Protected routes reject unauthenticated requests
- [ ] Passwords are securely hashed
- [ ] Rate limiting prevents brute force
- [ ] All tests pass
- [ ] Security audit passes

## Evaluation Criteria

| Criterion | Weight | Description |
|-----------|--------|-------------|
| Security | 30% | Password handling, token security, vulnerability prevention |
| Correctness | 25% | All requirements implemented correctly |
| Code Quality | 20% | Clean, maintainable, well-tested |
| Robustness | 15% | Error handling, edge cases, recovery |
| Compatibility | 10% | Works with existing codebase |

## Research Guidance

Subagents may research:
- OWASP authentication best practices
- bcrypt/argon2 password hashing
- JWT security considerations
- Express.js middleware patterns

Use official documentation and security advisories only.

## Output Paths

- Plans: `.claude/tmp/sessions/auth-system/plans/`
- Implementations: `.claude/tmp/worktrees/auth-`
- Reports: `.claude/tmp/sessions/auth-system/reports/`
```

---

## Tips for Good Task Specs

### Requirements Should Be

- **Specific**: "Hash passwords with bcrypt" not "Store passwords securely"
- **Testable**: "Login returns JWT within 200ms" not "Login should be fast"
- **Independent**: Each requirement can be evaluated separately
- **Complete**: Cover all aspects of the problem

### Constraints Should Be

- **Clear**: "Must use PostgreSQL" not "Must use a database"
- **Justified**: Explain why the constraint exists
- **Achievable**: Don't over-constrain

### Success Criteria Should Be

- **Measurable**: Can be objectively verified
- **Comprehensive**: Cover all requirements
- **Prioritized**: Most critical first

### Evaluation Criteria Should

- **Sum to 100%**: Weights must add up
- **Match priorities**: Higher weight for more important aspects
- **Include rubrics**: Specific scoring definitions
