# ADR 0011: Parallel work happens in git worktrees on local branches; the reviewer merges

- Status: Accepted (reviewer's recommendation under delegated authority, 2026-09-19)
- Date: 2026-09-19
- Decision label: D5

## Context

The earlier flow was: write in a staging copy that has no git history, copy the result
into the release clone, commit from there. It works for one contributor. With several
working in parallel they overwrite each other in the same directory, and nothing is
reviewed before the code reaches `main`.

## Decision

- Each contributor works in a separate git worktree of the release clone, on a branch
  named `wp/NNN-short-slug`, based on the current `main`. One branch carries one work
  package.
- Delivery is local. The contributor commits on the branch and writes a report of what
  changed and what evidence supports it. The contributor does not push and does not open
  pull requests.
- The reviewer inspects the branch, re-runs the evidence, and merges it into `main`.
  Nothing is committed to `main` directly.
- The staging environment used for integration runs is not written to by contributors.
  The reviewer realigns it to `main` after each merge.
- The author of every commit is the maintainer identity configured in the repository.
  There are no co-author trailers. A `commit-msg` hook installed in the repository
  enforces both.
- Commit messages are in English: an imperative subject and a body that explains why.

## Consequences

- Two branches that touch the same files are reconciled by the reviewer at merge time,
  so work packages are split by area to keep that rare.
- Branch protection on `main` (required pull request, green CI) is a repository
  setting and is outside this decision. It becomes relevant when the repository accepts
  external contributions.
- Every branch has to pass the three test suites in containers before it is delivered:
  `scripts/dev/test-go.sh`, `test-backend.sh` and `test-frontend.sh`.
