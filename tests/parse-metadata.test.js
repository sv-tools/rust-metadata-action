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
  assert.deepEqual(out, { packages: [], publish: [], matrix: [] });
});

test("missing packages key yields empty arrays", () => {
  const out = parseMetadata({});
  assert.deepEqual(out, { packages: [], publish: [], matrix: [] });
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
