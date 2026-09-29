/**
 * Tests for the Tailscale ACL drift detection extension.
 *
 * No live API calls — the comparison logic is pure, and the HuJSON reader is
 * exercised against the tricky cases (comment markers inside strings, trailing
 * commas, block comments).
 *
 * @module
 */

import { assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1";
import { createModelTestContext } from "jsr:@swamp-club/swamp-testing@0.20260928.39";
import {
  canonicalize,
  comparePolicies,
  extension,
  hasComments,
  parseHujson,
} from "./tailscale_acl_drift.ts";

/** The drift method's execute function under test. */
const driftExec = extension.methods[0].drift.execute;
type DriftCtx = Parameters<typeof driftExec>[1];

/**
 * Run drift.execute against a temp policy file and an optional seeded live
 * snapshot. Cleans up the temp file on every path.
 */
async function runDriftExecute(
  policyFile: string,
  liveSnapshot: Record<string, unknown> | null,
): Promise<{
  written: Array<{ specName: string; name: string; data: unknown }>;
  warnings: Array<{ message: string }>;
}> {
  const dir = await Deno.makeTempDir();
  const path = `${dir}/policy.hujson`;
  await Deno.writeTextFile(path, policyFile);
  const { context, getWrittenResources, getLogsByLevel } =
    createModelTestContext({
      storedResources: liveSnapshot ? { current: liveSnapshot } : {},
    });
  try {
    await driftExec(
      { policyPath: path, liveInstance: "current" },
      context as unknown as DriftCtx,
    );
    return {
      written: getWrittenResources().map((r) => ({
        specName: r.specName,
        name: r.name,
        data: r.data,
      })),
      warnings: getLogsByLevel("warning"),
    };
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("parseHujson strips line comments", () => {
  const src = `{
    // leading comment
    "acls": [], // trailing comment
  }`;
  assertEquals(parseHujson(src), { acls: [] });
});

Deno.test("parseHujson strips block comments", () => {
  const src = `{
    /* multi
       line */
    "acls": []
  }`;
  assertEquals(parseHujson(src), { acls: [] });
});

Deno.test("parseHujson preserves comment markers inside strings", () => {
  const src = `{ "hosts": { "web": "https://example.com/path" } }`;
  assertEquals(parseHujson(src), {
    hosts: { web: "https://example.com/path" },
  });
});

Deno.test("parseHujson preserves escaped quotes inside strings", () => {
  const src = String.raw`{ "note": "he said \"//not a comment\"" }`;
  assertEquals(parseHujson(src), { note: 'he said "//not a comment"' });
});

Deno.test("parseHujson handles trailing commas in arrays and objects", () => {
  const src = `{ "acls": [ {"action": "accept",}, ], }`;
  assertEquals(parseHujson(src), { acls: [{ action: "accept" }] });
});

Deno.test("parseHujson throws on genuinely malformed input", () => {
  assertThrows(() => parseHujson(`{ "acls": [ }`));
});

Deno.test("hasComments detects real comments but ignores string content", () => {
  assertEquals(hasComments(`{ "a": "http://x" }`), false);
  assertEquals(hasComments(`{ "a": 1 } // yes`), true);
  assertEquals(hasComments(`{ /* yes */ "a": 1 }`), true);
});

Deno.test("canonicalize is key-order independent", () => {
  assertEquals(
    canonicalize({ b: 1, a: 2 }),
    canonicalize({ a: 2, b: 1 }),
  );
});

Deno.test("canonicalize is array-order sensitive", () => {
  // ACL rule order is semantically meaningful — reordering is real drift.
  assertEquals(canonicalize([1, 2]) === canonicalize([2, 1]), false);
});

Deno.test("comparePolicies reports no differences when equal", () => {
  const policy = { acls: [{ action: "accept" }], tagOwners: {} };
  assertEquals(comparePolicies({ ...policy }, { ...policy }), []);
});

Deno.test("comparePolicies classifies each divergence", () => {
  const live = { acls: [{ action: "accept" }], nodeAttrs: [] };
  const file = { acls: [{ action: "deny" }], grants: [] };

  assertEquals(comparePolicies(live, file), [
    { section: "acls", state: "changed" },
    { section: "grants", state: "only-file" },
    { section: "nodeAttrs", state: "only-live" },
  ]);
});

Deno.test("comparePolicies ignores key ordering within a section", () => {
  const live = { tagOwners: { "tag:a": ["x"], "tag:b": ["y"] } };
  const file = { tagOwners: { "tag:b": ["y"], "tag:a": ["x"] } };
  assertEquals(comparePolicies(live, file), []);
});

Deno.test("execute reports in-sync when file matches the live snapshot", async () => {
  const { written, warnings } = await runDriftExecute(
    '// a comment that must not count as drift\n{"acls":[{"action":"accept"}]}',
    { acls: [{ action: "accept" }] },
  );
  assertEquals(written.length, 1);
  assertEquals(written[0].specName, "drift");
  assertEquals(written[0].name, "drift");
  const data = written[0].data as {
    inSync: boolean;
    commentsPresent: boolean;
    differences: unknown[];
  };
  assertEquals(data.inSync, true);
  assertEquals(data.commentsPresent, true);
  assertEquals(data.differences, []);
  assertEquals(warnings.length, 0);
});

Deno.test("execute flags a section present only in the file", async () => {
  const { written, warnings } = await runDriftExecute(
    '{"acls":[{"action":"accept"}],"hosts":{"web":"192.0.2.10"}}',
    { acls: [{ action: "accept" }] },
  );
  const data = written[0].data as {
    inSync: boolean;
    differences: Array<{ section: string; state: string }>;
  };
  assertEquals(data.inSync, false);
  assertEquals(data.differences, [{ section: "hosts", state: "only-file" }]);
  assertEquals(warnings.length, 1); // drift logs a warning
});

Deno.test("execute flags a section present only on the tailnet", async () => {
  const { written } = await runDriftExecute(
    '{"acls":[{"action":"accept"}]}',
    { acls: [{ action: "accept" }], nodeAttrs: [] },
  );
  const data = written[0].data as {
    differences: Array<{ section: string; state: string }>;
  };
  assertEquals(data.differences, [{ section: "nodeAttrs", state: "only-live" }]);
});

Deno.test("execute throws when no live snapshot was captured", async () => {
  await assertRejects(
    () => runDriftExecute('{"acls":[]}', null),
    Error,
    "Run the `get` method",
  );
});

Deno.test("execute throws when the policy file cannot be read", async () => {
  const { context } = createModelTestContext({
    storedResources: { current: { acls: [] } },
  });
  await assertRejects(
    () =>
      driftExec(
        { policyPath: "/nonexistent/policy.hujson", liveInstance: "current" },
        context as unknown as DriftCtx,
      ),
    Error,
    "Could not read policy file",
  );
});
