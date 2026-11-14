# one-store-forge

A GitHub-compatible git forge in a single process. Standard library only:
no git binary, no package manager, no outside service.

## What it serves

- **Git smart HTTP** — upload-pack protocol v2 (ls-refs, fetch with
  shallow/deepen, thin-pack safe) with a v0 fallback, and receive-pack with
  per-ref report-status and non-fast-forward refusal.
- **REST v3** — repositories, branches, git refs, commits, contents, labels,
  issues, pull requests (including squash merge with conflict detection).
- **GraphQL v4** — viewer, repository, issues with cursor pagination,
  pull requests, node by global id, mutations, and `__type` introspection.
- **MCP** — Streamable HTTP at `/mcp`, revision 2026-07-28
  (`server/discover`, `tools/list`, `tools/call`), plus the legacy
  `initialize` handshake.

Everything reads and writes one in-memory store, so an object created over
any surface is the same object over every other surface.

## Run

```sh
node --experimental-strip-types main.ts
```

Dev mode listens on `FORGE_PORT` (default 8734). In a make.fun trial the
process binds an ephemeral port, registers it at `$MAKEFUN_ENV_URL/register`,
and exits when `/done` reports true.

## Layout

- `main.ts` — bootstrap and the trial lifecycle.
- `src/scenario.ts` — the seeded viewer identity (derived, not hardcoded).
- `src/objects.ts` — git objects, packs, pkt-lines.
- `src/store.ts` — repositories, refs, issues, pull requests, merges.
- `src/gitproto.ts` — smart HTTP.
- `src/rest.ts` — REST v3.
- `src/graphql.ts` — GraphQL v4 (hand-written parser and executor).
- `src/mcp.ts` — MCP tools.
- `src/server.ts` — HTTP plumbing and routing.
