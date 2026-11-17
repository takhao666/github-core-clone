# github-core-clone

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/takhao666/github-core-clone/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/takhao666/github-core-clone/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A single-process GitHub-compatible git forge (Node 22, standard library only): git smart-HTTP clone/fetch/push, REST v3, GraphQL and MCP, all backed by one in-memory store with deterministic state.

## Run it

```sh
npm start
```

`main.ts` binds an ephemeral port, registers it with the trial env at `$MAKEFUN_ENV_URL`, serves until the env says the trial is done, then exits 0. No network access is needed at run time except serving git/HTTP clients, and there are no dependencies to install.

## What it does

- **Git smart HTTP** at `/{owner}/{repo}.git`: upload-pack protocol v2 (advertisement, `ls-refs` with peel/symrefs/unborn/ref-prefix, `fetch` with ACK/NAK, shallow-info, depth and `deepen-relative`, sideband packfiles) and receive-pack v0 (fast-forward checks, delete-refs, report-status-v2 inside a single band-1 packet). Packs are version 2, SHA-1, plain entries; incoming packs are unpacked including OFS/REF deltas. Verified with the real `git` CLI: push, clone, shallow clone (`--depth 1`), `fetch --deepen=1`, annotated tag push, `ls-remote`, empty-repo clone, non-fast-forward rejection.
- **REST v3** at `/api/v3`: repos (create/list with Link pagination/get/patch/delete), git refs, branches, commits, contents (create/update/delete, branch creation on write), labels, issues (filter/sort, comments), pull requests (files, squash/merge/rebase, 405 on a three-way conflict). Bearer-token auth, `X-GitHub-Request-Id` on every reply, JSON errors.
- **GraphQL** at `/api/graphql`: viewer, repository (incl. `node(id:)`), issues and pull requests with cursor pagination, `__type` introspection, batched operation arrays, mutations (`createIssue`, `closeIssue`, `createPullRequest`, `mergePullRequest`, `addComment`).
- **MCP** at `/mcp`: JSON-RPC 2.0 Streamable HTTP, `server/discover`, `initialize`, `tools/list` (create_repo, get_repo, create_issue, list_issues, create_pull_request, merge_pull_request) and `tools/call`, acting on the same store as REST.
- **Deterministic**: no wall-clock time or randomness in responses (scenario-epoch timestamps, sequence counters), so two runs on the same instance export byte-identical state.

## Local grading

Graded with the competition kit (`node cli/makefun.mjs grade-local --kit . --bot . --driver process --instances 1`) on practice trial-0:

- **score 956 / 1000** — feature 600/600 (120/120 conformance), agent 200/200 (15/15 MCP), perf 156/200 (push 35, clone 40, read 47, write 34)
- replay matched byte for byte; L1 regrade reproduced byte for byte

---

<sub>Entered on [make.fun](https://make.fun/?ref=hvn9m3q0&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
