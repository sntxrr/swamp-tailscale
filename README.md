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
| `@sntxrr/tailscale-acl-drift`            | `@john/tailscale-acl`      | `drift` — read-only comparison of live policy vs. `policy.hujson`    |
| `@sntxrr/tailscale-external-acl-management` | `@john/tailscale-settings` | `setExternalAclManagement` — set `aclsExternallyManagedOn` (verifies) |

`tailscale-acl-drift` also ships the `acl-drift-check` workflow (`workflows/`),
which chains the base model's `get` with `drift`.

## Development

Extensions are developed against local source and registered with
`swamp extension source add <dir>`. Unit tests are colocated and run with Deno:

```bash
deno test --allow-read extensions/models/tailscale-acl-drift/
```

This repo tracks extension **sources** and shareable **workflows**. Model and
vault **instances** are developer-specific (bound to one tailnet and OAuth
client) and are gitignored.

## License

MIT — see each extension's `LICENSE.md`.
