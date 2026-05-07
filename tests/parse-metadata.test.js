import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMetadata } from "../lib.js";

const baselinePkg = {
  name: "ignored",
  publish: null,
  features: {},
};

test("empty workspace yields empty arrays", () => {
  const out = parseMetadata({ packages: [] });
  assert.deepEqual(out, {
    packages: [],
    publish: [],
    matrix: [],
    rustVersion: "",
    edition: "",
  });
});

test("missing packages key yields empty arrays", () => {
  const out = parseMetadata({});
  assert.deepEqual(out, {
    packages: [],
    publish: [],
    matrix: [],
    rustVersion: "",
    edition: "",
  });
});

test("featureless package goes into matrix as bare --package", () => {
  const out = parseMetadata({
    packages: [{ ...baselinePkg, name: "foo" }],
  });
  assert.deepEqual(out.matrix, ["--package=foo"]);
});

test("each feature produces its own matrix entry", () => {
  const out = parseMetadata({
    packages: [
      {
        ...baselinePkg,
        name: "foo",
        features: { default: ["a"], full: ["a", "b"] },
      },
    ],
  });
  assert.deepEqual(out.matrix, [
    "--package=foo --features=default",
    "--package=foo --features=full",
  ]);
});

test("publish=null is publishable", () => {
  const out = parseMetadata({
    packages: [{ ...baselinePkg, name: "foo", publish: null }],
  });
  assert.deepEqual(out.publish, ["foo"]);
});

test("publish=[] (i.e. publish = false in Cargo.toml) is NOT publishable", () => {
  const out = parseMetadata({
    packages: [{ ...baselinePkg, name: "foo", publish: [] }],
  });
  assert.deepEqual(out.publish, []);
});

test("publish=['registry'] (restricted) is still publishable", () => {
  const out = parseMetadata({
    packages: [{ ...baselinePkg, name: "foo", publish: ["my-registry"] }],
  });
  assert.deepEqual(out.publish, ["foo"]);
});

test("packages output always contains every package, regardless of publish", () => {
  const out = parseMetadata({
    packages: [
      { ...baselinePkg, name: "a", publish: null },
      { ...baselinePkg, name: "b", publish: [] },
      { ...baselinePkg, name: "c", publish: ["my-registry"] },
    ],
  });
  assert.deepEqual(out.packages, ["a", "b", "c"]);
  assert.deepEqual(out.publish, ["a", "c"]);
});

test("rust-version is empty string when no package declares one", () => {
  const out = parseMetadata({
    packages: [{ ...baselinePkg, name: "foo", rust_version: null }],
  });
  assert.equal(out.rustVersion, "");
});

test("rust-version returns the max across packages", () => {
  const out = parseMetadata({
    packages: [
      { ...baselinePkg, name: "a", rust_version: "1.85" },
      { ...baselinePkg, name: "b", rust_version: "1.90" },
      { ...baselinePkg, name: "c", rust_version: null },
    ],
  });
  assert.equal(out.rustVersion, "1.90");
});

test("rust-version compares numerically, not lexicographically", () => {
  // Lexicographic compare would pick "1.9" over "1.10".
  const out = parseMetadata({
    packages: [
      { ...baselinePkg, name: "a", rust_version: "1.9" },
      { ...baselinePkg, name: "b", rust_version: "1.10" },
    ],
  });
  assert.equal(out.rustVersion, "1.10");
});

test("rust-version handles patch-level versions", () => {
  const out = parseMetadata({
    packages: [
      { ...baselinePkg, name: "a", rust_version: "1.85.0" },
      { ...baselinePkg, name: "b", rust_version: "1.85.5" },
    ],
  });
  assert.equal(out.rustVersion, "1.85.5");
});

test("edition returns the max across packages", () => {
  const out = parseMetadata({
    packages: [
      { ...baselinePkg, name: "a", edition: "2021" },
      { ...baselinePkg, name: "b", edition: "2024" },
      { ...baselinePkg, name: "c", edition: "2018" },
    ],
  });
  assert.equal(out.edition, "2024");
});

test("edition is empty string for empty workspace", () => {
  const out = parseMetadata({ packages: [] });
  assert.equal(out.edition, "");
});
