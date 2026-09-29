/**
 * Tests for the Tailscale ACL change-proposal extension.
 *
 * No live API calls. These focus on the behavior unique to `propose`: writing
 * the proposed HuJSON to disk byte-for-byte (comments preserved), diffing the
 * proposal against the live snapshot, and refusing to stage invalid input.
 *
 * @module
 */

import { assertEquals, assertRejects, assertStringIncludes } from "jsr:@std/assert@1";
import { createModelTestContext } from "jsr:@swamp-club/swamp-testing@0.20260928.39";
import { extension } from "./tailscale_acl_propose.ts";

/** The propose method's execute function under test. */
const proposeExec = extension.methods[0].propose.execute;
type ProposeCtx = Parameters<typeof proposeExec>[1];

interface ProposalData {
  changed: boolean;
  targetPath: string;
  bytesWritten: number;
  commentsPresent: boolean;
  differences: Array<{ section: string; state: string }>;
  prTitle: string;
  prBody: string;
  commitMessage: string;
  summary: string;
}

/**
 * Run propose.execute against a temp source file, writing to a distinct target
 * path so we can assert the bytes were copied verbatim. Cleans up on every path.
 */
async function runProposeExecute(
  sourceText: string,
  liveSnapshot: Record<string, unknown> | null,
  opts: { title?: string; inPlace?: boolean } = {},
): Promise<{
  data: ProposalData | null;
  targetBytes: string | null;
  warnings: Array<{ message: string }>;
  infos: Array<{ message: string }>;
}> {
  const dir = await Deno.makeTempDir();
  const sourcePath = `${dir}/source.hujson`;
  const targetPath = opts.inPlace ? sourcePath : `${dir}/policy.hujson`;
  await Deno.writeTextFile(sourcePath, sourceText);
  const { context, getWrittenResources, getLogsByLevel } =
    createModelTestContext({
      storedResources: liveSnapshot ? { current: liveSnapshot } : {},
    });
  try {
    await proposeExec(
      {
        sourcePath,
        targetPath,
        liveInstance: "current",
        title: opts.title,
      },
      context as unknown as ProposeCtx,
    );
    const written = getWrittenResources();
    let targetBytes: string | null = null;
    try {
      targetBytes = await Deno.readTextFile(targetPath);
    } catch {
      targetBytes = null;
    }
    return {
      data: written.length
        ? (written[0].data as unknown as ProposalData)
        : null,
      targetBytes,
      warnings: getLogsByLevel("warning"),
      infos: getLogsByLevel("info"),
    };
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("propose writes the proposal verbatim, preserving comments and trailing commas", async () => {
  const source = `// GitOps-managed ACL policy
{
  "acls": [
    { "action": "accept", "src": ["*"], "dst": ["*:*"] }, // allow all
  ],
  "hosts": { "web": "192.0.2.10" },
}`;
  const { data, targetBytes } = await runProposeExecute(
    source,
    { acls: [{ action: "accept", src: ["*"], dst: ["*:*"] }] },
  );
  // Byte-for-byte identical — never re-serialized.
  assertEquals(targetBytes, source);
  assertEquals(data?.commentsPresent, true);
  assertEquals(data?.bytesWritten, new TextEncoder().encode(source).length);
});

Deno.test("propose diffs the proposal against the live tailnet", async () => {
  const { data, warnings, infos } = await runProposeExecute(
    '{"acls":[{"action":"deny"}],"hosts":{"web":"192.0.2.10"}}',
    { acls: [{ action: "accept" }], ssh: [] },
  );
  assertEquals(data?.changed, true);
  assertEquals(data?.differences, [
    { section: "acls", state: "changed" },
    { section: "hosts", state: "only-proposed" },
    { section: "ssh", state: "only-live" },
  ]);
  // A real change logs info, not a warning.
  assertEquals(infos.length >= 1, true);
  assertEquals(warnings.length, 0);
  assertStringIncludes(data?.prTitle ?? "", "acls, hosts, ssh");
  assertStringIncludes(data?.prBody ?? "", "single writer");
});

Deno.test("propose warns and reports no change when proposal matches live", async () => {
  const { data, warnings } = await runProposeExecute(
    '{"acls":[{"action":"accept"}]}',
    { acls: [{ action: "accept" }] },
  );
  assertEquals(data?.changed, false);
  assertEquals(data?.differences, []);
  // No-op relative to live is worth surfacing.
  assertEquals(warnings.length, 1);
  assertStringIncludes(data?.prTitle ?? "", "no live-policy change");
});

Deno.test("propose supports validating an in-place edit (source == target)", async () => {
  const source = '{"acls":[{"action":"accept"}],"grants":[]}';
  const { data, targetBytes } = await runProposeExecute(
    source,
    { acls: [{ action: "accept" }] },
    { inPlace: true },
  );
  assertEquals(targetBytes, source);
  assertEquals(data?.differences, [{ section: "grants", state: "only-proposed" }]);
});

Deno.test("propose honors a title override", async () => {
  const { data } = await runProposeExecute(
    '{"acls":[{"action":"deny"}]}',
    { acls: [{ action: "accept" }] },
    { title: "Lock down prod ACL" },
  );
  assertEquals(data?.prTitle, "Lock down prod ACL");
});

Deno.test("propose refuses to stage invalid HuJSON", async () => {
  await assertRejects(
    () => runProposeExecute('{ "acls": [ }', { acls: [] }),
    Error,
    "invalid HuJSON",
  );
});

Deno.test("propose refuses a proposal that is not a JSON object", async () => {
  await assertRejects(
    () => runProposeExecute('["not", "an", "object"]', { acls: [] }),
    Error,
    "did not parse to an object",
  );
});

Deno.test("propose throws when no live snapshot was captured", async () => {
  await assertRejects(
    () => runProposeExecute('{"acls":[]}', null),
    Error,
    "Run the `get` method",
  );
});

Deno.test("propose throws when the source file cannot be read", async () => {
  const { context } = createModelTestContext({
    storedResources: { current: { acls: [] } },
  });
  await assertRejects(
    () =>
      proposeExec(
        {
          sourcePath: "/nonexistent/source.hujson",
          targetPath: "/tmp/should-not-be-written.hujson",
          liveInstance: "current",
        },
        context as unknown as ProposeCtx,
      ),
    Error,
    "Could not read proposed policy",
  );
});
