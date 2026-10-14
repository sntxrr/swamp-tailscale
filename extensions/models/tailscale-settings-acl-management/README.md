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

## Setup

The method extends the `@john/tailscale-settings` type, so it runs against a
model instance of that type. Create one with the tailnet name and credentials;
keep the credentials in a vault rather than on the command line.

```bash
swamp extension pull @john/tailscale
swamp extension pull @sntxrr/tailscale-external-acl-management

swamp model create @john/tailscale-settings my-tailnet \
  --global-arg tailnet=example.com \
  --global-arg 'oauthClientId=${{ vault.get("tailscale", "oauth-client-id") }}' \
  --global-arg 'oauthClientSecret=${{ vault.get("tailscale", "oauth-client-secret") }}'
```

Credentials are resolved the same way as the base model: `apiKey` wins if it
is set; otherwise `oauthClientId` and `oauthClientSecret` are exchanged for a
token (with `oauthScopes`, if given). `baseUrl` overrides
`https://api.tailscale.com`. With neither form of credential set, the method
fails before making any request.

## Usage

```bash
# Lock the ACL editor (mark ACLs as externally/GitOps-managed)
swamp model method run my-tailnet setExternalAclManagement --input enabled=true

# Unlock
swamp model method run my-tailnet setExternalAclManagement --input enabled=false
```

### Arguments

| Argument  | Required | Description                                                  |
| --------- | -------- | ------------------------------------------------------------ |
| `enabled` | yes      | `true` marks ACLs externally managed (locks editor); `false` clears |

### What a run does

1. Reads the tailnet settings (`GET /api/v2/tailnet/{tailnet}/settings`) and
   records the previous value of `aclsExternallyManagedOn`.
2. Sends `PATCH /api/v2/tailnet/{tailnet}/settings` with only
   `{"aclsExternallyManagedOn": <enabled>}`.
3. Reads the settings again and compares. If the read-back value differs from
   `enabled`, the method throws and writes no data.
4. Logs `aclsExternallyManagedOn: <previous> -> <actual>` and writes the full
   read-back settings object as the `settings` resource, instance `current`.

## Caveats

- **It is idempotent but not a no-op.** Running it with the value already set
  still sends the PATCH; the log line then shows the same value on both sides.
- **The stored resource is the whole settings object** as read back after the
  change, not just this flag.
- **A non-2xx PATCH fails with the API's status and body** in the error, so a
  permissions refusal is visible as such rather than as a generic failure.
- **Locking the editor affects everyone.** Once on, admins can no longer edit
  the policy in the console; make sure the GitOps pipeline that owns the policy
  file is working before turning it on.

## Requirements

- `@john/tailscale-settings` installed (`swamp extension pull @john/tailscale`)
- **Write-capable** OAuth credentials. This method writes; a read-only
  (`policy_file:read`) client — the recommended setup for drift detection — will
  be refused with "calling actor does not have enough permissions". That refusal
  is by design: with read-only creds in the vault, swamp cannot change tailnet
  settings.

## License

MIT
