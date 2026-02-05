# Example: API Refactoring Workflow

This example demonstrates how to apply the multi-agent orchestration framework to refactor a REST API to GraphQL.

---

## Task Specification

```markdown
# Task: Refactor REST API to GraphQL

## Context

Our Express.js application has a REST API with 15 endpoints. We're experiencing:
- Over-fetching on mobile clients
- N+1 query problems
- Difficulty versioning endpoints
- Inconsistent response formats

## Problem Statement

Refactor the REST API to GraphQL while maintaining backwards compatibility with existing REST clients during a transition period.

## Requirements

1. **Schema Design**
   - Type definitions for all entities (User, Post, Comment)
   - Query types for read operations
   - Mutation types for write operations
   - Proper nullability annotations

2. **Resolver Implementation**
   - Resolvers for all types and fields
   - DataLoader for N+1 prevention
   - Error handling with proper GraphQL errors

3. **Authentication Integration**
   - Context injection of authenticated user
   - Field-level authorization
   - Rate limiting per operation

4. **REST Compatibility Layer**
   - Keep REST endpoints working
   - Optional: REST-to-GraphQL proxy

5. **Testing**
   - Unit tests for resolvers
   - Integration tests for queries/mutations
   - Performance tests comparing REST vs GraphQL

## Constraints

- Must use Apollo Server
- Must maintain REST API for 6 months
- Cannot break existing mobile app (v2.3+)
- Must complete within existing infrastructure

## Success Criteria

- [ ] All entities have GraphQL types
- [ ] All REST operations available via GraphQL
- [ ] N+1 queries eliminated (DataLoader implemented)
- [ ] Authentication works identically to REST
- [ ] Performance equal or better than REST
- [ ] All tests pass

## Evaluation Criteria

| Criterion | Weight | Description |
|-----------|--------|-------------|
| Schema Quality | 25% | Type design, nullability, naming conventions |
| Performance | 20% | DataLoader usage, query optimization |
| Correctness | 20% | All operations work correctly |
| Code Quality | 15% | Resolver organization, maintainability |
| Compatibility | 10% | REST layer preserved |
| Testing | 10% | Coverage and test quality |

## Research Guidance

Subagents may research:
- Apollo Server best practices (2025-2026)
- GraphQL schema design patterns
- DataLoader implementation
- graphql-tools documentation
```

---

## Phase 1: Planning

### Orchestrator Launches Parallel Planners

```
Task: Spawn 2 planning subagents

Subagent A: Schema-first approach
Subagent B: Code-first approach
```

### Subagent A Plan Summary

**Approach**: Schema-first with SDL files

```markdown
## Executive Summary
Use .graphql SDL files as source of truth, generate TypeScript types.

## Architecture
```
src/
  graphql/
    schema/
      user.graphql
      post.graphql
    resolvers/
      user.ts
      post.ts
    dataloaders/
      userLoader.ts
```

## Key Decisions
- SDL files in `src/graphql/schema/`
- graphql-codegen for type generation
- Context factory for auth injection
```

### Subagent B Plan Summary

**Approach**: Code-first with TypeGraphQL

```markdown
## Executive Summary
Use TypeGraphQL decorators on TypeScript classes.

## Architecture
```
src/
  graphql/
    types/
      User.ts       # @ObjectType decorator
      Post.ts
    resolvers/
      UserResolver.ts  # @Resolver decorator
    middleware/
      auth.ts       # @Authorized decorator
```

## Key Decisions
- TypeGraphQL for type-safe schema
- Decorators for field definitions
- Class-based resolvers
```

### Plan Comparison

| Aspect | Subagent A (Schema-first) | Subagent B (Code-first) |
|--------|---------------------------|-------------------------|
| Type Safety | Generated from SDL | Native TypeScript |
| Learning Curve | Lower (standard GraphQL) | Higher (TypeGraphQL) |
| Flexibility | More control over SDL | Decorator constraints |
| Tooling | graphql-codegen needed | TypeGraphQL built-in |
| Team Familiarity | GraphQL standard | TypeScript patterns |

### User Decision

```
User: Approve both plans. Add Subagent C with hybrid approach:
- SDL for public schema
- Code-first for internal types
- Federation-ready architecture
```

---

## Phase 2: Implementation

### Git Worktrees Created

```bash
git worktree add -b graphql/schema-first .claude/tmp/worktrees/graphql-a develop
git worktree add -b graphql/code-first .claude/tmp/worktrees/graphql-b develop
git worktree add -b graphql/hybrid .claude/tmp/worktrees/graphql-c develop
```

### Implementation Summary

| Solution | Files | Lines | Approach |
|----------|-------|-------|----------|
| A | 12 | 850 | SDL + codegen |
| B | 15 | 720 | TypeGraphQL |
| C | 18 | 1100 | Hybrid + Federation |

---

## Phase 3: Evaluation

### Evaluator Scores

| Criterion | Weight | A | B | C |
|-----------|--------|---|---|---|
| Schema Quality | 25% | 8/10 | 9/10 | 9/10 |
| Performance | 20% | 7/10 | 8/10 | 9/10 |
| Correctness | 20% | 9/10 | 9/10 | 9/10 |
| Code Quality | 15% | 8/10 | 9/10 | 8/10 |
| Compatibility | 10% | 9/10 | 8/10 | 10/10 |
| Testing | 10% | 7/10 | 8/10 | 9/10 |
| **Weighted Total** | | **8.00** | **8.55** | **8.95** |

### Key Findings

**Solution A**:
- Clean SDL separation
- Codegen adds build complexity
- DataLoader implementation incomplete

**Solution B**:
- Excellent type safety
- Cleaner resolver code
- REST compatibility limited

**Solution C**:
- Best of both worlds
- Federation-ready for future microservices
- Most thorough testing

### Recommendation

**Winner**: Solution C (Hybrid approach)

**Reasoning**: Solution C combines the clarity of SDL for public schema with the type safety of TypeGraphQL for internal types. The federation-ready architecture provides future scalability without current overhead.

---

## Git Notes Example

```markdown
## Subagent C Implementation Notes

### Schema Design Decisions

1. **Public SDL + Internal Types**
   - Public schema in `schema.graphql` for documentation
   - Internal types use TypeGraphQL for type safety
   - buildFederatedSchema() merges both

2. **DataLoader Organization**
   - One loader per entity
   - Context factory creates fresh loaders per request
   - Batch functions use repository pattern

### Performance Optimizations

- DataLoader eliminates N+1 queries
- Persisted queries for production
- Response caching with @cacheControl

### Testing Strategy

- Unit tests: 95% resolver coverage
- Integration: Full query flow tests
- Performance: Baseline comparison with REST

### Trade-offs

| Decision | Alternative | Why This Choice |
|----------|-------------|-----------------|
| Hybrid schema | Pure SDL | Type safety for internal code |
| Class resolvers | Function resolvers | Better organization |
| Apollo Server | Yoga | Team familiarity |
```

---

## Lessons from This Example

1. **Diverse approaches reveal trade-offs**: Schema-first vs code-first showed different strengths
2. **User can enhance mid-workflow**: Adding Subagent C with hybrid approach
3. **Evaluation criteria matter**: Performance weight caught DataLoader gaps
4. **Winner wasn't obvious**: All solutions had merit
