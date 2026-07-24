# swamp-tailscale

A [swamp](https://swamp-club.com) extension repo for **Tailscale** ACL policy
operations, using only Deno's built-in `fetch` — no vendor SDK.

These extensions build on top of [`@john/tailscale`](https://swamp-club.com)
(which wraps the Tailscale API as swamp models) via `export const extension`,
adding capabilities that base model lacks rather than duplicating it.

## Design premise

ACLs are managed via GitOps — a single `policy.hujson` in a git repository,
applied to the tailnet by CI (`tailscale/gitops-acl-action`) on merge. That
pipeline is the **single writer**. These extensions are deliberately built so
swamp never becomes a second writer that could race the pipeline:

- **Drift detection** reads the live policy and compares it to the file. It
  never writes to the tailnet.
- **Change proposal** stages an edit as a pull request against `policy.hujson`.
  It writes a file and opens a PR — it never calls the Tailscale API, so merging
  (not swamp) is what applies the change, through the same single writer.
- Credentials are a **read-only** OAuth client (`policy_file:read`), so the
  boundary is enforced by the credential, not by convention.

## Authentication

Both extensions inherit `@john/tailscale`'s OAuth global arguments, wired from a
swamp vault (never hardcoded). Use an OAuth client scoped to `policy_file:read`
for drift detection:

```bash
swamp vault create local_encryption tailscale
swamp vault put tailscale OAUTH_CLIENT_ID   # read-only OAuth client id
swamp vault put tailscale OAUTH_SECRET      # read-only OAuth client secret
```

Note: Tailscale's token endpoint silently falls back to the client's full scope
set if the *entire* requested scope string is unrecognized, so the durable
boundary is the client's own grant, not the requested scope. See the extension
READMEs for details.

## Extensions

| Extension                                | Extends                   | Adds                                                                 |
| ---------------------------------------- | ------------------------- | ------------------------------------------------------------------- |
| `@sntxrr/tailscale-acl-drift`            | `@john/tailscale-acl`      | `drift` — read-only comparison of live policy vs. `policy.hujson`; `propose` — stage an ACL change as a PR |
| `@sntxrr/tailscale-external-acl-management` | `@john/tailscale-settings` | `setExternalAclManagement` — set `aclsExternallyManagedOn` (verifies) |

`tailscale-acl-drift` ships two workflows (`workflows/`):

- **`acl-drift-check`** chains the base model's `get` with `drift`.
- **`propose-acl`** chains `get` → branch → `propose` → commit → push → open PR,
  reusing [`@twonines/git-workspace`](https://swamp-club.com) for git and
  [`@goodcraft/github`](https://swamp-club.com) for the pull request.

### The `propose-acl` workflow

```bash
swamp workflow run propose-acl \
  --input sourcePath=/absolute/path/to/edited-policy.hujson \
  --input repoPath=/absolute/path/to/acl-repo-checkout \
  --input branch=acl/my-change
  # add --input dryRun=false to actually open the PR
```

`propose` writes the proposed HuJSON to `repoPath/policy.hujson` **verbatim**
(comments preserved — it is never re-serialized), diffs it against the live
tailnet for the PR body, then git-workspace commits + pushes the branch and
`@goodcraft/github` opens the PR. `openPr` defaults to `dryRun: true`, so the
branch is pushed but no PR is created until you pass `dryRun=false`.

Two model instances back the git/PR steps — create them once:

```bash
swamp model create @twonines/git-workspace acl-repo \
  --global-arg host=github.com --global-arg protocol=ssh
swamp model create @goodcraft/github acl-github \
  --global-arg "token=\${{ vault.get('github', 'GITHUB_TOKEN') }}" \
  --global-arg owner=<your-org-or-user>

swamp vault create local_encryption github
swamp vault put github GITHUB_TOKEN   # a token with PR-create rights on the ACL repo
```

git-workspace pushes over SSH (your existing key); `@goodcraft/github` opens the
PR over the REST API using the vault token. Swamp still never touches Tailscale.

## Development

Extensions are developed against local source and registered with
`swamp extension source add <dir>`. Unit tests are colocated and run with Deno:

```bash
# --allow-write is needed: the tests write fixtures to a temp dir.
deno test --allow-read --allow-write extensions/models/tailscale-acl-drift/
```

This repo tracks extension **sources** and shareable **workflows**. Model and
vault **instances** are developer-specific (bound to one tailnet and OAuth
client) and are gitignored.

## License

MIT — see each extension's `LICENSE.md`.
