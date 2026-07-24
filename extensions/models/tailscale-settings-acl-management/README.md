# @sntxrr/tailscale-external-acl-management

Extends [`@john/tailscale-settings`](https://swamp-club.com) with a
`setExternalAclManagement` method that sets the tailnet's
`aclsExternallyManagedOn` flag **and verifies the change actually applied.**

## Why this exists

The base model's `update` method cannot set this field. `aclsExternallyManagedOn`
is not declared in its zod arguments schema, and zod strips unknown keys — so
calling `update` with it sends an **empty PATCH**, then reports success without
changing anything. This method sends the field explicitly and reads it back,
throwing if the API accepted the request without applying it.

## What the flag does

When on, the Tailscale admin console shows the policy as *"managed externally and
locked in the editor"* and blocks edits there — changes must go through the API
or GitOps. It is **enforcing**, not advisory. (Tailscale's older GitOps blog post
describes it as a warning banner; the live console behaviour is stricter — this
was verified directly against the console.)

## Usage

```bash
# Lock the ACL editor (mark ACLs as externally/GitOps-managed)
swamp model @john/tailscale-settings method run setExternalAclManagement my-tailnet \
  --input enabled=true

# Unlock
swamp model @john/tailscale-settings method run setExternalAclManagement my-tailnet \
  --input enabled=false
```

### Arguments

| Argument  | Required | Description                                                  |
| --------- | -------- | ------------------------------------------------------------ |
| `enabled` | yes      | `true` marks ACLs externally managed (locks editor); `false` clears |

## Requirements

- `@john/tailscale-settings` installed (`swamp extension pull @john/tailscale`)
- **Write-capable** OAuth credentials. This method writes; a read-only
  (`policy_file:read`) client — the recommended setup for drift detection — will
  be refused with "calling actor does not have enough permissions". That refusal
  is by design: with read-only creds in the vault, swamp cannot change tailnet
  settings.

## License

MIT
