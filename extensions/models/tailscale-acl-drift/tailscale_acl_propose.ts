/**
 * Change-proposal path for GitOps-managed Tailscale ACL policies.
 *
 * Extends `@john/tailscale-acl` with a `propose` method that stages an ACL
 * change as a git commit against the GitOps `policy.hujson`, so the change can
 * be reviewed and merged through the normal pull-request pipeline. It never
 * writes to the tailnet: applying policy remains the sole responsibility of the
 * GitOps action, preserving a single writer and avoiding last-push-wins races.
 *
 * `propose` deliberately takes the proposed policy as **HuJSON text** and writes
 * it byte-for-byte to disk — it never re-serializes a parsed object, so
 * comments and formatting survive intact. It parses the text only to validate
 * it and to diff it against the live tailnet snapshot for the PR description.
 *
 * Intended use in a workflow: run `@john/tailscale-acl`'s `get` to snapshot the
 * live policy, create a branch (`@twonines/git-workspace`), run `propose` to
 * write the file and produce the PR title/body, then commit + push
 * (`@twonines/git-workspace`) and open the PR (`@goodcraft/github`).
 *
 * @module
 */

import { z } from "npm:zod@4";
import {
  comparePolicies,
  hasComments,
  type Json,
  parseHujson,
} from "./tailscale_acl_drift.ts";

/** Shape of a detected difference between the live tailnet and the proposal. */
const ProposedDifferenceSchema = z.object({
  section: z.string().describe(
    "Top-level policy key that would change (e.g. acls, grants, ssh, tagOwners).",
  ),
  state: z
    .enum(["only-live", "only-proposed", "changed"])
    .describe(
      "How the section diverges: present only on the tailnet today, only in the proposal, or present in both with different contents.",
    ),
});

/** Result snapshot written by the `propose` method. */
const ProposalSchema = z.object({
  changed: z
    .boolean()
    .describe(
      "True when the proposal differs from the policy currently live on the tailnet.",
    ),
  targetPath: z
    .string()
    .describe("Filesystem path the proposed policy.hujson was written to."),
  bytesWritten: z
    .number()
    .describe("Size, in bytes, of the HuJSON text written to targetPath."),
  commentsPresent: z
    .boolean()
    .describe(
      "True when the proposed HuJSON contains comments (written verbatim, never stripped).",
    ),
  differences: z
    .array(ProposedDifferenceSchema)
    .describe(
      "Per-section differences versus the live tailnet; empty when none.",
    ),
  prTitle: z.string().describe("Suggested pull-request title."),
  prBody: z.string().describe("Suggested pull-request body, in Markdown."),
  commitMessage: z
    .string()
    .describe("Suggested commit message (imperative subject + body)."),
  summary: z
    .string()
    .describe("Human-readable one-line summary suitable for logs or alerting."),
});

/** Render the PR body / commit body Markdown from the section differences. */
function renderChangeList(
  differences: Array<z.infer<typeof ProposedDifferenceSchema>>,
): string {
  const label: Record<
    z.infer<typeof ProposedDifferenceSchema>["state"],
    string
  > = {
    "only-live": "removed (present live, absent in proposal)",
    "only-proposed": "added (absent live, present in proposal)",
    changed: "changed",
  };
  return differences
    .map((d) => `- \`${d.section}\` — ${label[d.state]}`)
    .join("\n");
}

export const extension = {
  type: "@john/tailscale-acl",

  resources: {
    proposal: {
      description:
        "A staged ACL change: the proposed policy written to the GitOps file, plus the pull-request metadata describing it.",
      schema: ProposalSchema,
      lifetime: "infinite",
      garbageCollection: 30,
    },
  },

  methods: [
    {
      propose: {
        description:
          "Stage a Tailscale ACL change for review: write proposed HuJSON to the GitOps policy file (verbatim, comments preserved), diff it against the live tailnet, and emit pull-request metadata. Read-only against the tailnet — never applies policy.",
        arguments: z.object({
          sourcePath: z
            .string()
            .describe(
              "Absolute path to read the proposed policy.hujson text from. May equal targetPath to validate an in-place edit.",
            ),
          targetPath: z
            .string()
            .describe(
              "Absolute path of the GitOps policy.hujson to write (inside the git checkout that will be committed).",
            ),
          liveInstance: z
            .string()
            .default("current")
            .describe(
              "Instance name of the live ACL snapshot written by the `get` method, used to describe the change.",
            ),
          title: z
            .string()
            .optional()
            .describe(
              "Optional pull-request title override. Defaults to a summary of the changed sections.",
            ),
        }),
        execute: async (
          args: {
            sourcePath: string;
            targetPath: string;
            liveInstance: string;
            title?: string;
          },
          context: {
            readResource?: (
              instanceName: string,
              version?: number,
            ) => Promise<Record<string, unknown> | null>;
            writeResource: (
              spec: string,
              instance: string,
              data: unknown,
            ) => Promise<unknown>;
            logger: {
              info: (msg: string, props?: Record<string, unknown>) => void;
              warn: (msg: string, props?: Record<string, unknown>) => void;
            };
          },
        ): Promise<{ dataHandles: unknown[] }> => {
          const live = await context.readResource?.(args.liveInstance);
          if (!live) {
            throw new Error(
              `No ACL snapshot found under instance "${args.liveInstance}". Run the \`get\` method on this model first.`,
            );
          }

          let source: string;
          try {
            source = await Deno.readTextFile(args.sourcePath);
          } catch (e) {
            throw new Error(
              `Could not read proposed policy at ${args.sourcePath}: ${
                (e as Error).message
              }`,
            );
          }

          const commentsPresent = hasComments(source);

          // Parse only to validate the proposal and to diff it — never to
          // rewrite it. The text is committed byte-for-byte so comments survive.
          let proposed: Json;
          try {
            proposed = parseHujson(source);
          } catch (e) {
            throw new Error(
              `Refusing to stage invalid HuJSON from ${args.sourcePath}: ${
                (e as Error).message
              }`,
            );
          }
          if (
            proposed === null || typeof proposed !== "object" ||
            Array.isArray(proposed)
          ) {
            throw new Error(
              `Proposed policy at ${args.sourcePath} did not parse to an object.`,
            );
          }

          // comparePolicies is symmetric structurally; the second argument's
          // exclusive sections come back as "only-file", which for a proposal
          // means "only-proposed".
          const differences = comparePolicies(
            live as Record<string, Json>,
            proposed as Record<string, Json>,
          ).map((d) => ({
            section: d.section,
            state: (d.state === "only-file" ? "only-proposed" : d.state) as
              | "only-live"
              | "only-proposed"
              | "changed",
          }));
          const changed = differences.length > 0;

          // Write the proposal verbatim. `readTextFile` above already loaded the
          // exact bytes; writing them back preserves comments and formatting.
          try {
            await Deno.writeTextFile(args.targetPath, source);
          } catch (e) {
            throw new Error(
              `Could not write proposed policy to ${args.targetPath}: ${
                (e as Error).message
              }`,
            );
          }
          const bytesWritten = new TextEncoder().encode(source).length;

          const sectionList = differences.map((d) => d.section).join(", ");
          const prTitle = args.title ??
            (changed
              ? `Propose Tailscale ACL update: ${sectionList}`
              : "Propose Tailscale ACL update (no live-policy change)");

          const changeList = changed
            ? renderChangeList(differences)
            : "_No differences from the policy currently live on the tailnet — this proposal codifies the current state._";

          const prBody = [
            "Proposed change to the GitOps-managed Tailscale ACL policy.",
            "",
            "### Effect on the tailnet when merged",
            "",
            changeList,
            "",
            "### How this was produced",
            "",
            "- Written by the `@sntxrr/tailscale-acl-drift` `propose` method.",
            "- Swamp does **not** apply this policy; merging triggers the GitOps",
            "  action, which stays the single writer to the tailnet.",
            `- Proposed HuJSON written verbatim${
              commentsPresent ? " (comments preserved)" : ""
            } — never re-serialized.`,
          ].join("\n");

          const commitMessage = changed
            ? `Update Tailscale ACL policy: ${sectionList}\n\n${
              renderChangeList(differences)
            }`
            : "Codify current Tailscale ACL policy\n\nNo change relative to the live tailnet.";

          const summary = changed
            ? `Proposed ACL change touching ${differences.length} section(s): ${
              differences.map((d) => `${d.section} (${d.state})`).join(", ")
            }.`
            : "Proposed ACL matches the live tailnet policy (no functional change).";

          if (changed) {
            context.logger.info("Staged ACL proposal to {path}: {summary}", {
              path: args.targetPath,
              summary,
            });
          } else {
            context.logger.warn(
              "Staged ACL proposal to {path} with no change vs. live policy",
              { path: args.targetPath },
            );
          }

          const handle = await context.writeResource("proposal", "proposal", {
            changed,
            targetPath: args.targetPath,
            bytesWritten,
            commentsPresent,
            differences,
            prTitle,
            prBody,
            commitMessage,
            summary,
          });

          return { dataHandles: [handle] };
        },
      },
    },
  ],
};
