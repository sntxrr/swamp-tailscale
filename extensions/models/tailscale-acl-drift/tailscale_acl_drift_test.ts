/**
 * Tests for the Tailscale ACL drift detection extension.
 *
 * No live API calls — the comparison logic is pure, and the HuJSON reader is
 * exercised against the tricky cases (comment markers inside strings, trailing
 * commas, block comments).
 *
 * @module
 */

import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import {
  canonicalize,
  comparePolicies,
  hasComments,
  parseHujson,
} from "./tailscale_acl_drift.ts";

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
