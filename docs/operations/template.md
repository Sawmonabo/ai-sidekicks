# Operations Doc Minimum Requirements

## Purpose

This file defines the minimum structure and writing rules for canonical docs in `operations/`.

## Required Sections

Every operations doc must include:

1. `Purpose`
2. `Symptoms`
3. `Detection`
4. `Preconditions`
5. `Recovery Steps`
6. `Validation`
7. `Escalation`
8. `Related Architecture Docs`
9. `Related Specs`
10. `Related Plans`

## Writing Rules

- Write recovery steps as explicit actions.
- Separate detection from remediation.
- Name blast radius or scope when relevant.
- Avoid hand-wavy guidance like `check logs`; say which logs and what to look for.

## Quality Bar

An operations doc is not complete unless:

- an agent or engineer can follow it during failure without missing context
- the success condition after recovery is explicit
