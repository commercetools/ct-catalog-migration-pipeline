import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildChangeset, decide, diffRuntime, runtimePackages } from "./dependency-changeset.mjs";

const lock = (packages) => ({ lockfileVersion: 3, packages: { "": { name: "x" }, ...packages } });

describe("runtimePackages", () => {
  it("keeps what the lockfile does not mark dev, and names nested copies by package", () => {
    const result = runtimePackages(
      lock({
        "node_modules/ajv": { version: "8.20.0" },
        "node_modules/ajv/node_modules/fast-uri": { version: "3.1.9" },
        "node_modules/typescript": { version: "7.0.2", dev: true },
        "node_modules/@scope/pkg": { version: "1.0.0" },
      }),
    );
    assert.deepEqual([...result.keys()].sort(), ["@scope/pkg", "ajv", "fast-uri"]);
  });

  it("collects several installed versions of one package", () => {
    const result = runtimePackages(
      lock({
        "node_modules/a": { version: "2.0.0" },
        "node_modules/b/node_modules/a": { version: "1.0.0" },
      }),
    );
    assert.deepEqual(result.get("a"), ["1.0.0", "2.0.0"]);
  });
});

describe("diffRuntime", () => {
  it("reports added, removed and changed packages by name", () => {
    const before = new Map([["a", ["1.0.0"]], ["b", ["1.0.0"]], ["same", ["1.0.0"]]]);
    const after = new Map([["a", ["1.1.0"]], ["c", ["2.0.0"]], ["same", ["1.0.0"]]]);
    assert.deepEqual(diffRuntime(before, after), [
      { name: "a", from: "1.0.0", to: "1.1.0" },
      { name: "b", from: "1.0.0", to: null },
      { name: "c", from: null, to: "2.0.0" },
    ]);
  });
});

describe("decide", () => {
  const base = { packageName: "ct-catalog-migration-pipeline", version: "0.2.0" };
  const before = lock({ "node_modules/ajv": { version: "8.20.0" }, "node_modules/ts": { version: "1.0.0", dev: true } });

  it("adds nothing while the current version has no tag: its release is pending", () => {
    const result = decide({ ...base, tags: ["v0.1.0"], lockAtTag: before, lockNow: lock({}) });
    assert.equal(result.write, false);
    assert.match(result.reason, /v0\.2\.0 is not tagged yet/);
  });

  it("adds nothing when only a dev dependency changed", () => {
    const now = lock({ "node_modules/ajv": { version: "8.20.0" }, "node_modules/ts": { version: "2.0.0", dev: true } });
    const result = decide({ ...base, tags: ["v0.2.0"], lockAtTag: before, lockNow: now });
    assert.equal(result.write, false);
    assert.match(result.reason, /no runtime dependency changed/);
  });

  it("adds a patch changeset when a runtime dependency changed", () => {
    const now = lock({ "node_modules/ajv": { version: "8.21.0" }, "node_modules/ts": { version: "1.0.0", dev: true } });
    const result = decide({ ...base, tags: ["v0.2.0"], lockAtTag: before, lockNow: now });
    assert.equal(result.write, true);
    assert.match(result.content, /^---\n"ct-catalog-migration-pipeline": patch\n---\n/);
    assert.match(result.content, /- ajv: 8\.20\.0 -> 8\.21\.0/);
    assert.match(result.content, /changed since v0\.2\.0/);
  });

  it("adds nothing when the lockfile at the tag is missing", () => {
    const result = decide({ ...base, tags: ["v0.2.0"], lockAtTag: null, lockNow: before });
    assert.equal(result.write, false);
  });
});

describe("buildChangeset", () => {
  it("lists at most 25 packages and counts the rest", () => {
    const changes = Array.from({ length: 30 }, (_, i) => ({
      name: `p${String(i).padStart(2, "0")}`,
      from: "1.0.0",
      to: "1.0.1",
    }));
    const text = buildChangeset("x", "v1.0.0", changes);
    assert.equal(text.split("\n").filter((l) => l.startsWith("- p")).length, 25);
    assert.match(text, /- and 5 more/);
  });
});
