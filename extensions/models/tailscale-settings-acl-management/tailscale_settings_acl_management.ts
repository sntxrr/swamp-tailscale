/**
 * External ACL management toggle for Tailscale tailnet settings.
 *
 * Extends `@john/tailscale-settings` with a method that sets the
 * `aclsExternallyManagedOn` field. That field is not declared in the base
 * model's `update` arguments schema, and zod strips unknown keys, so calling
 * the base `update` with it silently sends an empty PATCH and reports success
 * without changing anything. This method sends it explicitly and then verifies
 * the value actually changed, failing loudly if it did not.
 *
 * Note: on the current admin console this setting is enforcing, not advisory.
 * With it on, the console shows the policy as "managed externally and locked in
 * the editor" and blocks edits there; changes must go through the API/GitOps.
 * (Tailscale's older GitOps blog post describes it as a mere warning — the live
 * console behaviour is stricter, verified directly against the console.)
 *
 * @module
 */

import { z } from "npm:zod@4";

/** Global arguments inherited from the base `@john/tailscale-settings` model. */
interface TailscaleGlobals {
  tailnet: string;
  oauthClientId?: string;
  oauthClientSecret?: string;
  oauthScopes?: string[];
  apiKey?: string;
  baseUrl?: string;
}

/**
 * Obtain a bearer token for the Tailscale API.
 *
 * Prefers an explicit API key; otherwise performs an OAuth client-credentials
 * exchange. Mirrors the base model's auth behaviour — the base model's helper
 * is internal to that package and cannot be imported from an extension.
 *
 * @param g Global arguments carrying credentials.
 * @returns A bearer token string.
 */
async function getToken(g: TailscaleGlobals): Promise<string> {
  if (g.apiKey) return g.apiKey;

  if (!g.oauthClientId || !g.oauthClientSecret) {
    throw new Error(
      "No credentials: set apiKey, or both oauthClientId and oauthClientSecret.",
    );
  }

  const base = g.baseUrl ?? "https://api.tailscale.com";
  const params = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: g.oauthClientId,
    client_secret: g.oauthClientSecret,
  });
  if (g.oauthScopes?.length) params.set("scope", g.oauthScopes.join(" "));

  const resp = await fetch(`${base}/api/v2/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  if (!resp.ok) {
    throw new Error(
      `OAuth token request failed (${resp.status}): ${await resp.text()}`,
    );
  }
  return (await resp.json()).access_token as string;
}

/**
 * Read the current tailnet settings.
 *
 * @param g Global arguments carrying credentials.
 * @param token Bearer token.
 * @returns The settings object as returned by the API.
 */
async function readSettings(
  g: TailscaleGlobals,
  token: string,
): Promise<Record<string, unknown>> {
  const base = g.baseUrl ?? "https://api.tailscale.com";
  const url = `${base}/api/v2/tailnet/${
    encodeURIComponent(g.tailnet)
  }/settings`;
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) {
    throw new Error(
      `Settings read failed (${resp.status}): ${await resp.text()}`,
    );
  }
  return await resp.json();
}

/** Extension adding the verified `setExternalAclManagement` method. */
export const extension = {
  type: "@john/tailscale-settings",

  methods: [
    {
      setExternalAclManagement: {
        description:
          "Set aclsExternallyManagedOn, then verify the change took effect. When on, the admin console locks the policy editor — edits must go through the API/GitOps.",
        arguments: z.object({
          enabled: z
            .boolean()
            .describe(
              "True to mark ACLs as externally managed (GitOps); false to clear.",
            ),
        }),
        execute: async (
          args: { enabled: boolean },
          context: {
            globalArgs: TailscaleGlobals;
            writeResource: (
              spec: string,
              instance: string,
              data: unknown,
            ) => Promise<unknown>;
            logger: {
              info: (msg: string, props?: Record<string, unknown>) => void;
            };
          },
        ): Promise<{ dataHandles: unknown[] }> => {
          const g = context.globalArgs;
          const token = await getToken(g);

          const before = await readSettings(g, token);
          const previous = before.aclsExternallyManagedOn;

          const base = g.baseUrl ?? "https://api.tailscale.com";
          const url = `${base}/api/v2/tailnet/${
            encodeURIComponent(g.tailnet)
          }/settings`;

          const patch = await fetch(url, {
            method: "PATCH",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ aclsExternallyManagedOn: args.enabled }),
          });

          if (!patch.ok) {
            throw new Error(
              `Settings PATCH failed (${patch.status}): ${await patch.text()}`,
            );
          }

          // Read back and assert. A PATCH the API accepts but ignores would
          // otherwise be indistinguishable from success.
          const after = await readSettings(g, token);
          const actual = after.aclsExternallyManagedOn;

          if (actual !== args.enabled) {
            throw new Error(
              `PATCH reported success but aclsExternallyManagedOn is ${
                JSON.stringify(actual)
              }, expected ${args.enabled}. The API accepted the request without applying it.`,
            );
          }

          context.logger.info(
            "aclsExternallyManagedOn: {previous} -> {actual}",
            { previous, actual },
          );

          const handle = await context.writeResource(
            "settings",
            "current",
            after,
          );
          return { dataHandles: [handle] };
        },
      },
    },
  ],
};
