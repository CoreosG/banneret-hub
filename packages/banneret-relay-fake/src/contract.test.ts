// @effect-diagnostics nodeBuiltinImport:off - reads the canonical README and signs with node:crypto.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";

import { describe, expect, it } from "vite-plus/test";

import { keyFromSeed, signingInput, verify } from "./signing.ts";
import {
  exampleSchemas,
  invalidExampleSchema,
  listExamples,
  loadSpec,
  readExample,
  readOpenApi,
  specDirectory,
} from "./spec.ts";

// The canonical contract itself: schemas, examples and signing vectors. No relay needed.
const spec = loadSpec();

const vectorSeed = Uint8Array.from({ length: 32 }, (_, index) => index);

// The README's test vector table: | `"<signing input as a JSON string>"` | `<signature>` |
const readmeVectors = NodeFS.readFileSync(`${specDirectory}README.md`, "utf8")
  .split("\n")
  .flatMap((line) => {
    const match = /^\| `("relay\/v1.*")` \| `([A-Za-z0-9+/]{86}==)` \|$/.exec(line);
    return match?.[1] && match[2]
      ? [{ input: JSON.parse(match[1]) as string, signature: match[2] }]
      : [];
  });

describe("relay v1 contract", () => {
  it("compiles every schema", () => {
    const components = readOpenApi().components as { schemas: Record<string, unknown> };
    expect(spec.schemaNames.toSorted()).toEqual(Object.keys(components.schemas).toSorted());
  });

  it("maps every valid example on disk to a schema", () => {
    expect(listExamples("")).toEqual(Object.keys(exampleSchemas).toSorted());
  });

  it.each(Object.entries(exampleSchemas))("validates example %s as %s", (file, schema) => {
    expect(spec.check(schema, readExample(file))).toBeNull();
  });

  it.each(listExamples("invalid/"))("refuses invalid example %s", (file) => {
    expect(spec.check(invalidExampleSchema(file), readExample(`invalid/${file}`))).not.toBeNull();
  });

  it("accepts unknown values in the open sets: needs-you kinds and roles", () => {
    const needs = readExample("needs.json") as { items: Array<{ kind: string }> };
    for (const item of needs.items) item.kind = "kind_added_in_v1_9";
    expect(spec.check("NeedsPage", needs)).toBeNull();
    const capabilities = readExample("capabilities.json") as {
      me: { role: string };
      mcpTools: Array<{ role: string }>;
    };
    capabilities.me.role = "auditor";
    for (const tool of capabilities.mcpTools) tool.role = "auditor";
    expect(spec.check("Capabilities", capabilities)).toBeNull();
    // Open, not free text: the value is still a lowercase token.
    for (const item of needs.items) item.kind = "Not a kind";
    expect(spec.check("NeedsPage", needs)).not.toBeNull();
  });

  it("accepts an error envelope with an unknown code, and refuses a malformed one", () => {
    const envelope = (code: unknown) => ({
      error: { code, message: "Plain words.", retryable: false },
    });
    expect(spec.check("Error", envelope("code_added_in_v1_9"))).toBeNull();
    expect(spec.check("Error", envelope("not_found"))).toBeNull();
    expect(spec.check("Error", envelope("Not A Code"))).not.toBeNull();
  });

  it("derives the README's public key from the vector seed", () => {
    expect(keyFromSeed(vectorSeed).publicKey).toBe("A6EHv/POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg=");
  });

  it("finds the signing vectors in the README", () => {
    expect(readmeVectors.length).toBeGreaterThanOrEqual(2);
  });

  it.each(readmeVectors)("reproduces signing vector $signature", ({ input, signature }) => {
    const key = keyFromSeed(vectorSeed);
    // Ed25519 is deterministic: the exact bytes must match, not only verify.
    expect(
      NodeCrypto.sign(null, Buffer.from(input, "utf8"), key.privateKey).toString("base64"),
    ).toBe(signature);
    const [prefix, method, target, device, counter, sentAt, ...body] = input.split("\n");
    expect(prefix).toBe("relay/v1");
    const parts = {
      method: method ?? "",
      target: target ?? "",
      device: device ?? "",
      counter: counter ?? "",
      sentAt: sentAt ?? "",
      body: Buffer.from(body.join("\n"), "utf8"),
    };
    expect(signingInput(parts).toString("utf8")).toBe(input);
    const publicKey = NodeCrypto.createPublicKey(key.privateKey);
    expect(verify(publicKey, parts, signature)).toBe(true);
    expect(verify(publicKey, { ...parts, counter: `${parts.counter}1` }, signature)).toBe(false);
  });
});
