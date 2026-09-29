/**
 * Tests for the external-ACL-management extension.
 *
 * No live API calls — globalThis.fetch is stubbed per test to route the OAuth
 * token exchange, the settings GET (before/after), and the settings PATCH.
 * Covers the success path, the read-back mismatch guard, a failed PATCH, and
 * missing credentials.
 *
 * @module
 */

import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { createModelTestContext } from "jsr:@swamp-club/swamp-testing@0.20260928.39";
import { extension } from "./tailscale_settings_acl_management.ts";

const exec = extension.methods[0].setExternalAclManagement.execute;
type SetCtx = Parameters<typeof exec>[1];

/** A single stubbed HTTP response. */
interface StubResponse {
  ok?: boolean;
  status?: number;
  json?: unknown;
  text?: string;
}

/**
 * Replace globalThis.fetch with a router. Returns a restore function that the
 * caller must invoke in a finally block.
 */
function stubFetch(
  route: (url: string, init?: RequestInit) => StubResponse,
): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const r = route(url, init);
    return Promise.resolve({
      ok: r.ok ?? true,
      status: r.status ?? 200,
      json: () => Promise.resolve(r.json ?? {}),
      text: () => Promise.resolve(r.text ?? ""),
    } as Response);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

const CREDS = {
  tailnet: "example.com",
  oauthClientId: "test-id",
  oauthClientSecret: "test-secret",
};

Deno.test("execute flips the flag and records the new settings", async () => {
  let patched = false;
  const restore = stubFetch((url, init) => {
    if (url.includes("/oauth/token")) return { json: { access_token: "tok" } };
    if (init?.method === "PATCH") {
      patched = true;
      return { ok: true };
    }
    return { json: { aclsExternallyManagedOn: patched } }; // GET before/after
  });
  try {
    const { context, getWrittenResources, getLogsByLevel } =
      createModelTestContext({ globalArgs: CREDS });
    await exec({ enabled: true }, context as unknown as SetCtx);
    const written = getWrittenResources();
    assertEquals(written.length, 1);
    assertEquals(written[0].specName, "settings");
    assertEquals(
      (written[0].data as { aclsExternallyManagedOn: boolean })
        .aclsExternallyManagedOn,
      true,
    );
    assertEquals(getLogsByLevel("info").length >= 1, true);
  } finally {
    restore();
  }
});

Deno.test("execute throws when the read-back does not reflect the change", async () => {
  const restore = stubFetch((url, init) => {
    if (url.includes("/oauth/token")) return { json: { access_token: "tok" } };
    if (init?.method === "PATCH") return { ok: true };
    return { json: { aclsExternallyManagedOn: false } }; // never changes
  });
  try {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: CREDS,
    });
    await assertRejects(
      () => exec({ enabled: true }, context as unknown as SetCtx),
      Error,
      "reported success but",
    );
    // Nothing written when the assertion fails.
    assertEquals(getWrittenResources().length, 0);
  } finally {
    restore();
  }
});

Deno.test("execute throws with status and body on a failed PATCH", async () => {
  const restore = stubFetch((url, init) => {
    if (url.includes("/oauth/token")) return { json: { access_token: "tok" } };
    if (init?.method === "PATCH") {
      return { ok: false, status: 400, text: "not permitted" };
    }
    return { json: { aclsExternallyManagedOn: false } };
  });
  try {
    const { context } = createModelTestContext({ globalArgs: CREDS });
    await assertRejects(
      () => exec({ enabled: true }, context as unknown as SetCtx),
      Error,
      "Settings PATCH failed (400)",
    );
  } finally {
    restore();
  }
});

Deno.test("execute throws when credentials are missing", async () => {
  // No fetch stub — getToken must throw before any request is made.
  const { context } = createModelTestContext({
    globalArgs: { tailnet: "example.com" },
  });
  await assertRejects(
    () => exec({ enabled: true }, context as unknown as SetCtx),
    Error,
    "No credentials",
  );
});
