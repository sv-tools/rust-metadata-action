import { test } from "node:test";
import assert from "node:assert/strict";
import {
  asyncPool,
  compareSemver,
  parseCargoInfoVersion,
  parseExcludeFeatures,
  parseExcludeList,
  parseMetadata,
  validateExclusions,
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

test("parseCargoInfoVersion strips ANSI escapes from cargo's colorized output", () => {
  // What `cargo info` emits when CARGO_TERM_COLOR=always is set in env —
  // the field label is wrapped in SGR codes, so a naive `^version:` regex
  // would miss it. Reproduces the CI warning seen against sv-tools/roas.
  const stdout =
    "\x1b[1m\x1b[92mversion:\x1b[0m 0.6.0\n" +
    "\x1b[1m\x1b[92mlicense:\x1b[0m MIT\n";
  assert.equal(parseCargoInfoVersion(stdout), "0.6.0");
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

test("parseExcludeList splits on commas, trims, drops empties", () => {
  assert.deepEqual(parseExcludeList(""), []);
  assert.deepEqual(parseExcludeList("foo"), ["foo"]);
  assert.deepEqual(parseExcludeList("foo,bar"), ["foo", "bar"]);
  assert.deepEqual(parseExcludeList("  foo  ,  bar  "), ["foo", "bar"]);
  assert.deepEqual(parseExcludeList("foo,,bar,,,baz"), ["foo", "bar", "baz"]);
});

test("parseExcludeList does NOT split on newlines (commas only)", () => {
  // A multi-line YAML string lands here as a single entry — that's by
  // design now. Workflows must use commas to delimit.
  assert.deepEqual(parseExcludeList("foo\nbar"), ["foo\nbar"]);
});

test("parseExcludeFeatures separates global vs package-scoped entries", () => {
  const out = parseExcludeFeatures(
    "unstable,foo:experimental,foo:nightly,bar:slow",
  );
  assert.deepEqual([...out.global], ["unstable"]);
  assert.deepEqual([...out.byPackage.get("foo")].sort(), [
    "experimental",
    "nightly",
  ]);
  assert.deepEqual([...out.byPackage.get("bar")], ["slow"]);
});

test("parseExcludeFeatures drops malformed entries with empty halves", () => {
  const out = parseExcludeFeatures(":foo,bar:");
  assert.equal(out.global.size, 0);
  assert.equal(out.byPackage.size, 0);
});

test("parseExcludeFeatures trims whitespace around the package:feature split", () => {
  // Common YAML shapes: `foo: nightly` or `foo : nightly` — the per-half
  // trim ensures the parsed names match real package/feature names exactly.
  const out = parseExcludeFeatures("foo: nightly, bar :  slow ");
  assert.deepEqual([...out.byPackage.get("foo")], ["nightly"]);
  assert.deepEqual([...out.byPackage.get("bar")], ["slow"]);
});

test("packagesExclude drops names from the packages output only", () => {
  const out = parseMetadata(
    {
      packages: [
        { ...baselinePkg, name: "keep", publish: null, version: "1.0.0" },
        {
          ...baselinePkg,
          name: "hide",
          publish: null,
          version: "1.0.0",
          features: { f: [] },
        },
      ],
    },
    { packagesExclude: ["hide"] },
  );
  // Dropped from `packages`, but `publish` and `matrix` are independent.
  assert.deepEqual(out.packages, ["keep"]);
  assert.deepEqual(
    out.publishCandidates.map((c) => c.name),
    ["keep", "hide"],
  );
  assert.deepEqual(out.matrix, [
    "--package=keep",
    "--package=hide --features=f",
  ]);
});

test("publishExclude drops names from publishCandidates only", () => {
  const out = parseMetadata(
    {
      packages: [
        { ...baselinePkg, name: "keep", publish: null, version: "1.0.0" },
        { ...baselinePkg, name: "vendored", publish: null, version: "1.0.0" },
      ],
    },
    { publishExclude: ["vendored"] },
  );
  assert.deepEqual(out.packages, ["keep", "vendored"]);
  assert.deepEqual(out.publishCandidates, [
    { name: "keep", version: "1.0.0", registries: [null] },
  ]);
  assert.deepEqual(out.matrix, ["--package=keep", "--package=vendored"]);
});

test("matrixExcludePackages drops the package's matrix rows but keeps it elsewhere", () => {
  const out = parseMetadata(
    {
      packages: [
        { ...baselinePkg, name: "keep" },
        { ...baselinePkg, name: "drop", features: { a: [], b: [] } },
      ],
    },
    { matrixExcludePackages: ["drop"] },
  );
  assert.deepEqual(out.packages, ["keep", "drop"]);
  assert.deepEqual(out.matrix, ["--package=keep"]);
});

test("matrixExcludePackages still allows the package into publishCandidates", () => {
  const out = parseMetadata(
    {
      packages: [
        { ...baselinePkg, name: "drop", publish: null, version: "1.0.0" },
      ],
    },
    { matrixExcludePackages: ["drop"] },
  );
  assert.deepEqual(out.publishCandidates, [
    { name: "drop", version: "1.0.0", registries: [null] },
  ]);
  assert.deepEqual(out.matrix, []);
});

test("matrixExcludeFeatures global entry strips that feature from every package", () => {
  const out = parseMetadata(
    {
      packages: [
        {
          ...baselinePkg,
          name: "foo",
          features: { default: [], unstable: [] },
        },
        {
          ...baselinePkg,
          name: "bar",
          features: { stable: [], unstable: [] },
        },
      ],
    },
    {
      matrixExcludeFeatures: {
        global: new Set(["unstable"]),
        byPackage: new Map(),
      },
    },
  );
  assert.deepEqual(out.matrix, [
    "--package=foo --features=default",
    "--package=bar --features=stable",
  ]);
});

test("matrixExcludeFeatures package-scoped entry only affects the named package", () => {
  const out = parseMetadata(
    {
      packages: [
        {
          ...baselinePkg,
          name: "foo",
          features: { a: [], b: [] },
        },
        {
          ...baselinePkg,
          name: "bar",
          features: { a: [], b: [] },
        },
      ],
    },
    {
      matrixExcludeFeatures: {
        global: new Set(),
        byPackage: new Map([["foo", new Set(["a"])]]),
      },
    },
  );
  assert.deepEqual(out.matrix, [
    "--package=foo --features=b",
    "--package=bar --features=a",
    "--package=bar --features=b",
  ]);
});

test("when every feature of a package is excluded, no rows are emitted for it", () => {
  // The package originally has features, so we don't fall back to a bare
  // `--package=foo` row — the user said "skip these features", not "fall
  // back to no-features mode".
  const out = parseMetadata(
    {
      packages: [{ ...baselinePkg, name: "foo", features: { a: [], b: [] } }],
    },
    {
      matrixExcludeFeatures: {
        global: new Set(["a", "b"]),
        byPackage: new Map(),
      },
    },
  );
  assert.deepEqual(out.matrix, []);
  assert.deepEqual(out.packages, ["foo"]);
});

test("validateExclusions accepts inputs that all map to real packages/features", () => {
  const metadata = {
    packages: [
      { ...baselinePkg, name: "foo", features: { default: [], full: [] } },
      { ...baselinePkg, name: "bar", features: { extra: [] } },
    ],
  };
  const errors = validateExclusions(metadata, {
    packagesExclude: ["foo"],
    publishExclude: ["bar"],
    matrixExcludePackages: ["foo"],
    matrixExcludeFeatures: {
      global: new Set(["default"]),
      byPackage: new Map([["bar", new Set(["extra"])]]),
    },
  });
  assert.deepEqual(errors, []);
});

test("validateExclusions flags unknown packages in each list", () => {
  const metadata = {
    packages: [{ ...baselinePkg, name: "real" }],
  };
  const errors = validateExclusions(metadata, {
    packagesExclude: ["typo-a"],
    publishExclude: ["typo-b"],
    matrixExcludePackages: ["typo-c"],
  });
  assert.equal(errors.length, 3);
  assert.ok(
    errors.some((e) => e.includes("packages-exclude") && e.includes("typo-a")),
  );
  assert.ok(
    errors.some((e) => e.includes("publish-exclude") && e.includes("typo-b")),
  );
  assert.ok(
    errors.some(
      (e) => e.includes("matrix-exclude-packages") && e.includes("typo-c"),
    ),
  );
});

test("validateExclusions flags global features that no package declares", () => {
  const metadata = {
    packages: [{ ...baselinePkg, name: "foo", features: { real: [] } }],
  };
  const errors = validateExclusions(metadata, {
    matrixExcludeFeatures: {
      global: new Set(["nonexistent"]),
      byPackage: new Map(),
    },
  });
  assert.equal(errors.length, 1);
  assert.ok(errors[0].includes("nonexistent"));
});

test("validateExclusions flags package-scoped feature when the package lacks it", () => {
  const metadata = {
    packages: [{ ...baselinePkg, name: "foo", features: { a: [] } }],
  };
  const errors = validateExclusions(metadata, {
    matrixExcludeFeatures: {
      global: new Set(),
      byPackage: new Map([["foo", new Set(["b"])]]),
    },
  });
  assert.equal(errors.length, 1);
  assert.ok(errors[0].includes('package "foo"'));
  assert.ok(errors[0].includes('feature "b"'));
});

test("validateExclusions flags unknown package in matrix-exclude-features", () => {
  const metadata = {
    packages: [{ ...baselinePkg, name: "foo", features: { a: [] } }],
  };
  const errors = validateExclusions(metadata, {
    matrixExcludeFeatures: {
      global: new Set(),
      byPackage: new Map([["bogus", new Set(["a"])]]),
    },
  });
  assert.equal(errors.length, 1);
  assert.ok(errors[0].includes("matrix-exclude-features"));
  assert.ok(errors[0].includes('"bogus"'));
});

test("validateExclusions: empty options produce no errors", () => {
  const metadata = { packages: [{ ...baselinePkg, name: "foo" }] };
  assert.deepEqual(validateExclusions(metadata, {}), []);
  assert.deepEqual(validateExclusions(metadata), []);
});

test("parseMetadata with no options behaves identically to the default case", () => {
  // Ensures the new options arg is fully backwards compatible: omitting it
  // should produce exactly the same output as before.
  const data = {
    packages: [
      { ...baselinePkg, name: "foo", features: { a: [] } },
      { ...baselinePkg, name: "bar" },
    ],
  };
  const a = parseMetadata(data);
  const b = parseMetadata(data, {});
  assert.deepEqual(a, b);
});
