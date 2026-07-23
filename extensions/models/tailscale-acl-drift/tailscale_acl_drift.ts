/**
 * Drift detection for GitOps-managed Tailscale ACL policies.
 *
 * Extends `@john/tailscale-acl` with a read-only `drift` method that compares
 * the policy currently live on the tailnet against the `policy.hujson` file in
 * a GitOps repository. It performs no writes to the tailnet — applying policy
 * remains the sole responsibility of the GitOps pipeline, preserving a single
 * writer and avoiding last-push-wins races.
 *
 * Intended use: run `@john/tailscale-acl`'s `get` method first to snapshot the
 * live policy, then run `drift` to compare that snapshot against the file.
 *
 * @module
 */

import { z } from "npm:zod@4";

/** Shape of a detected difference between live and file policy. */
const DifferenceSchema = z.object({
  section: z.string().describe(
    "Top-level policy key that differs (e.g. acls, grants, ssh, tagOwners).",
  ),
  state: z
    .enum(["only-live", "only-file", "changed"])
    .describe(
      "Where the section diverges: present only on the tailnet, only in the file, or present in both with different contents.",
    ),
});

/** Result snapshot written by the `drift` method. */
const DriftSchema = z.object({
  inSync: z
    .boolean()
    .describe("True when live tailnet policy matches the file semantically."),
  policyPath: z
    .string()
    .describe("Filesystem path of the GitOps policy file that was compared."),
  differences: z
    .array(DifferenceSchema)
    .describe("Per-section differences; empty when in sync."),
  commentsPresent: z
    .boolean()
    .describe(
      "True when the local policy file contains comments — these are stripped before comparison and are never treated as drift.",
    ),
  summary: z
    .string()
    .describe("Human-readable one-line summary suitable for alerting."),
});

/** Parsed JSON value produced by the HuJSON reader. */
type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

/**
 * Strip comments and trailing commas from HuJSON (JWCC) and parse it as JSON.
 *
 * Tailscale policy files are HuJSON: JSON with `//` and comments plus
 * trailing commas. This walks the source character by character so that
 * comment markers and commas appearing inside string literals are preserved
 * rather than mangled.
 *
 * @param source Raw HuJSON text.
 * @returns The parsed policy object.
 */
export function parseHujson(source: string): Json {
  let out = "";
  let inString = false;
  let escaped = false;

  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];

    if (inString) {
      out += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }

    if (ch === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i++;
      out += "\n";
      continue;
    }

    if (ch === "/" && next === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) {
        i++;
      }
      i++;
      continue;
    }

    out += ch;
  }

  // Drop trailing commas before a closing brace or bracket.
  const cleaned = out.replace(/,(\s*[}\]])/g, "$1");
  return JSON.parse(cleaned) as Json;
}

/**
 * Detect whether HuJSON source contains any comment outside of a string.
 *
 * @param source Raw HuJSON text.
 * @returns True when at least one `//` or comment is present.
 */
export function hasComments(source: string): boolean {
  let inString = false;
  let escaped = false;

  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];

    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "/" && (next === "/" || next === "*")) return true;
  }
  return false;
}

/**
 * Serialize a JSON value with object keys sorted, so that two structurally
 * equal policies compare equal regardless of key ordering.
 *
 * @param value Value to canonicalize.
 * @returns Deterministic string encoding of the value.
 */
export function canonicalize(value: Json): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${
    keys.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(",")
  }}`;
}

/**
 * Compare live and file policies section by section.
 *
 * @param live Policy currently active on the tailnet.
 * @param file Policy parsed from the GitOps repository.
 * @returns One entry per diverging top-level section.
 */
export function comparePolicies(
  live: Record<string, Json>,
  file: Record<string, Json>,
): Array<z.infer<typeof DifferenceSchema>> {
  const sections = new Set([...Object.keys(live), ...Object.keys(file)]);
  const differences: Array<z.infer<typeof DifferenceSchema>> = [];

  for (const section of [...sections].sort()) {
    const inLive = section in live;
    const inFile = section in file;

    if (inLive && !inFile) {
      differences.push({ section, state: "only-live" });
    } else if (!inLive && inFile) {
      differences.push({ section, state: "only-file" });
    } else if (canonicalize(live[section]) !== canonicalize(file[section])) {
      differences.push({ section, state: "changed" });
    }
  }

  return differences;
}

export const extension = {
  type: "@john/tailscale-acl",

  resources: {
    drift: {
      description:
        "Comparison between the live tailnet ACL policy and the GitOps policy file.",
      schema: DriftSchema,
      lifetime: "infinite",
      garbageCollection: 30,
    },
  },

  methods: [
    {
      drift: {
        description:
          "Compare the live tailnet ACL policy against a GitOps policy.hujson file. Read-only — never writes to the tailnet.",
        arguments: z.object({
          policyPath: z
            .string()
            .describe(
              "Absolute path to the GitOps policy.hujson file to compare against.",
            ),
          liveInstance: z
            .string()
            .default("current")
            .describe(
              "Instance name of the ACL snapshot written by the `get` method.",
            ),
        }),
        execute: async (
          args: { policyPath: string; liveInstance: string },
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
              warning: (msg: string, props?: Record<string, unknown>) => void;
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
            source = await Deno.readTextFile(args.policyPath);
          } catch (e) {
            throw new Error(
              `Could not read policy file at ${args.policyPath}: ${
                (e as Error).message
              }`,
            );
          }

          const commentsPresent = hasComments(source);

          let filePolicy: Json;
          try {
            filePolicy = parseHujson(source);
          } catch (e) {
            throw new Error(
              `Failed to parse HuJSON at ${args.policyPath}: ${
                (e as Error).message
              }`,
            );
          }

          if (
            filePolicy === null || typeof filePolicy !== "object" ||
            Array.isArray(filePolicy)
          ) {
            throw new Error(
              `Policy file at ${args.policyPath} did not parse to an object.`,
            );
          }

          const differences = comparePolicies(
            live as Record<string, Json>,
            filePolicy as Record<string, Json>,
          );
          const inSync = differences.length === 0;

          const summary = inSync
            ? "Tailnet ACL policy matches the GitOps file."
            : `Tailnet ACL policy has drifted from the GitOps file in ${differences.length} section(s): ${
              differences.map((d) => `${d.section} (${d.state})`).join(", ")
            }.`;

          if (inSync) {
            context.logger.info("ACL policy in sync with {path}", {
              path: args.policyPath,
            });
          } else {
            context.logger.warning("ACL drift detected: {summary}", {
              summary,
            });
          }

          // Instance names are NOT namespaced by resource spec — writing this
          // under "current" would version it into the same data name the base
          // model's `get` writes its ACL snapshot to, so a subsequent
          // readResource("current") would return a drift report instead of a
          // policy. Keep it under its own name.
          const handle = await context.writeResource("drift", "drift", {
            inSync,
            policyPath: args.policyPath,
            differences,
            commentsPresent,
            summary,
          });

          return { dataHandles: [handle] };
        },
      },
    },
  ],
};
