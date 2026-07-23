# @sntxrr/tailscale-acl-drift

Read-only drift detection for GitOps-managed Tailscale ACL policies.

Extends [`@john/tailscale-acl`](https://swamp-club.com) with a single `drift`
method that compares the policy currently live on your tailnet against the
`policy.hujson` file in your GitOps repository.

## Why read-only

If swamp could apply ACLs while a GitOps pipeline also applies them, you get
two writers and last-push-wins races: swamp applies at 14:00, a PR built from
the pre-swamp policy merges at 14:05, and the change silently disappears.

This extension never writes to the tailnet. Your CI pipeline
(`tailscale/gitops-acl-action` or equivalent) remains the only writer. Drift
detection answers the question that a push-only pipeline structurally cannot:
*did someone change the policy outside of git?*

That also makes it a live test of whether a locked admin console is actually
holding — a control that is otherwise assumed rather than verified.

## What counts as drift

Comparison is semantic, not textual:

| Difference                       | Reported as drift? |
| -------------------------------- | ------------------ |
| Comments added/removed in file   | No                 |
| Whitespace or formatting         | No                 |
| Object key ordering              | No                 |
| ACL rule **order** changed       | Yes                |
| Section added, removed, modified | Yes                |

ACL rule order is semantically meaningful in Tailscale, so array ordering is
treated as significant while object key ordering is not.

## Usage

`drift` reads the snapshot written by the base model's `get` method, so run
`get` first:

```bash
swamp model @john/tailscale-acl method run get my-tailnet
swamp model @john/tailscale-acl method run drift my-tailnet \
  --input policyPath=/absolute/path/to/tailscale-acls/policy.hujson
```

Or chain them in a workflow (see `workflows/acl-drift-check.yaml`):

```bash
swamp workflow run acl-drift-check \
  --input policyPath=/absolute/path/to/tailscale-acls/policy.hujson
```

`policyPath` must be absolute — `~` is not expanded.

### Arguments

| Argument       | Required | Default     | Description                                   |
| -------------- | -------- | ----------- | --------------------------------------------- |
| `policyPath`   | yes      | —           | Absolute path to the GitOps `policy.hujson`   |
| `liveInstance` | no       | `"current"` | Instance name of the snapshot `get` wrote     |

### Output

Writes a `drift` resource:

```json
{
  "inSync": false,
  "policyPath": "/home/user/git/tailscale-acls/policy.hujson",
  "differences": [
    { "section": "acls", "state": "changed" },
    { "section": "grants", "state": "only-live" }
  ],
  "commentsPresent": true,
  "summary": "Tailnet ACL policy has drifted from the GitOps file in 2 section(s): acls (changed), grants (only-live)."
}
```

`state` is one of `only-live` (present on the tailnet but not in git),
`only-file` (in git but not yet applied), or `changed`.

## HuJSON handling

Tailscale policy files are HuJSON — JSON with comments and trailing commas.
The parser walks the source character by character so that `//` sequences
inside string values (URLs, for instance) are not mistaken for comments.

## Requirements

- `@john/tailscale-acl` installed (`swamp extension pull @john/tailscale`)
- Tailscale OAuth client credentials wired into that model's global arguments
- Read access to the local policy file

## License

MIT
