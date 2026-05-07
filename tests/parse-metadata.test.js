import { test } from "node:test";
import assert from "node:assert/strict";
import {
  asyncPool,
  compareSemver,
  parseCargoInfoVersion,
  parseMetadata,
} from "../lib.js";

const baselinePkg = {
  name: "ignored",
  version: "0.1.0",
  publish: null,
  features: {},
};

test("empty workspace yields empty arrays", () => {
  const out = parseMetadata({ packages: [] });
  assert.deepEqual(out, {
    packages: [],
    publishCandidates: [],
    matrix: [],
    rustVersion: "",
    edition: "",
  });
});

test("missing packages key yields empty arrays", () => {
  const out = parseMetadata({});
  assert.deepEqual(out, {
    packages: [],
    publishCandidates: [],
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

test("matrix entries are sorted alphabetically by feature name", () => {
  // Deliberate reverse-alphabetical insertion order so we'd notice if
  // sorting were dropped (JS preserves Object insertion order).
  const out = parseMetadata({
    packages: [
      {
        ...baselinePkg,
        name: "foo",
        features: { zebra: [], mango: [], apple: [] },
      },
    ],
  });
  assert.deepEqual(out.matrix, [
    "--package=foo --features=apple",
    "--package=foo --features=mango",
    "--package=foo --features=zebra",
  ]);
});

test("publish=null is a publish candidate against the default registry", () => {
  const out = parseMetadata({
    packages: [
      { ...baselinePkg, name: "foo", publish: null, version: "1.2.3" },
    ],
  });
  assert.deepEqual(out.publishCandidates, [
    { name: "foo", version: "1.2.3", registries: [null] },
  ]);
});

test("publish=[] (i.e. publish = false in Cargo.toml) is NOT a candidate", () => {
  const out = parseMetadata({
    packages: [{ ...baselinePkg, name: "foo", publish: [] }],
  });
  assert.deepEqual(out.publishCandidates, []);
});

test("publish=['registry'] (restricted) is a candidate scoped to that registry", () => {
  const out = parseMetadata({
    packages: [
      {
        ...baselinePkg,
        name: "foo",
        publish: ["my-registry"],
        version: "0.5.0",
      },
    ],
  });
  assert.deepEqual(out.publishCandidates, [
    { name: "foo", version: "0.5.0", registries: ["my-registry"] },
  ]);
});

test("publish=['a','b'] preserves the full registry list", () => {
  // We can't predict which registry the user will `cargo publish --registry`
  // against, so the full list flows through and filterPublishable queries
  // each one (and uses the max version found).
  const out = parseMetadata({
    packages: [
      {
        ...baselinePkg,
        name: "foo",
        publish: ["registry-a", "registry-b"],
        version: "0.5.0",
      },
    ],
  });
  assert.deepEqual(out.publishCandidates, [
    {
      name: "foo",
      version: "0.5.0",
      registries: ["registry-a", "registry-b"],
    },
  ]);
});

test("packages output always contains every package, regardless of publish", () => {
  const out = parseMetadata({
    packages: [
      { ...baselinePkg, name: "a", publish: null, version: "1.0.0" },
      { ...baselinePkg, name: "b", publish: [], version: "1.0.0" },
      {
        ...baselinePkg,
        name: "c",
        publish: ["my-registry"],
        version: "1.0.0",
      },
    ],
  });
  assert.deepEqual(out.packages, ["a", "b", "c"]);
  assert.deepEqual(out.publishCandidates, [
    { name: "a", version: "1.0.0", registries: [null] },
    { name: "c", version: "1.0.0", registries: ["my-registry"] },
  ]);
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

test("compareSemver: equal versions return 0", () => {
  assert.equal(compareSemver("1.2.3", "1.2.3"), 0);
});

test("compareSemver: patch-level bump is greater", () => {
  assert.ok(compareSemver("1.2.4", "1.2.3") > 0);
  assert.ok(compareSemver("1.2.3", "1.2.4") < 0);
});

test("compareSemver: minor bump beats patch", () => {
  assert.ok(compareSemver("1.3.0", "1.2.99") > 0);
});

test("compareSemver: numeric (not lexical) compare on each component", () => {
  assert.ok(compareSemver("1.10.0", "1.9.0") > 0);
});

test("compareSemver: missing patch defaults to 0", () => {
  assert.equal(compareSemver("1.2", "1.2.0"), 0);
});

test("compareSemver: prerelease is lower than the same release", () => {
  assert.ok(compareSemver("1.2.3-rc.1", "1.2.3") < 0);
  assert.ok(compareSemver("1.2.3", "1.2.3-rc.1") > 0);
});

test("compareSemver: numeric prerelease segments compare numerically", () => {
  assert.ok(compareSemver("1.0.0-alpha.10", "1.0.0-alpha.2") > 0);
});

test("compareSemver: numeric prerelease segment ranks below alphanumeric", () => {
  assert.ok(compareSemver("1.0.0-alpha.1", "1.0.0-alpha.beta") < 0);
});

test("compareSemver: longer prerelease wins when prefix is equal (per semver §11)", () => {
  assert.ok(compareSemver("1.0.0-alpha.1", "1.0.0-alpha") > 0);
});

test("compareSemver: build metadata is ignored", () => {
  assert.equal(compareSemver("1.2.3+build.5", "1.2.3+build.9"), 0);
});

test("parseCargoInfoVersion picks up the canonical version line", () => {
  const stdout = [
    "    Updating crates.io index",
    "serde #serialization",
    "A generic serialization/deserialization framework",
    "version: 1.0.228",
    "license: MIT OR Apache-2.0",
    "",
  ].join("\n");
  assert.equal(parseCargoInfoVersion(stdout), "1.0.228");
});

test("parseCargoInfoVersion returns null when no version line is present", () => {
  assert.equal(parseCargoInfoVersion("just some unrelated text\n"), null);
});

test("parseCargoInfoVersion is case-insensitive on the key", () => {
  assert.equal(parseCargoInfoVersion("Version: 0.1.0\n"), "0.1.0");
});

test("asyncPool preserves input order", async () => {
  // Reverse-correlate delay with index so a naive implementation that
  // assigned results in completion order would scramble the output.
  const items = [0, 1, 2, 3, 4];
  const out = await asyncPool(2, items, async (i) => {
    await new Promise((r) => setTimeout(r, (items.length - i) * 5));
    return i * 10;
  });
  assert.deepEqual(out, [0, 10, 20, 30, 40]);
});

test("asyncPool caps in-flight workers at the limit", async () => {
  let inFlight = 0;
  let peak = 0;
  const items = Array.from({ length: 10 }, (_, i) => i);
  await asyncPool(3, items, async () => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
  });
  assert.ok(peak <= 3, `peak in-flight was ${peak}, expected ≤ 3`);
});

test("asyncPool handles empty input without spawning workers", async () => {
  let calls = 0;
  const out = await asyncPool(4, [], async () => {
    calls++;
  });
  assert.deepEqual(out, []);
  assert.equal(calls, 0);
});
