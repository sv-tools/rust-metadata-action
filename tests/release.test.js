import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildDepGraph,
  classifyTargets,
  DEFAULT_TAG_FORMAT,
  formatTag,
  parseMatrixMode,
  parseMetadata,
  parseTag,
  parseTagFormat,
  planRelease,
  publishWaves,
  resolveTag,
} from "../lib.js";

const pkg = (name, extra = {}) => ({
  name,
  version: "0.1.0",
  publish: null,
  features: {},
  targets: [{ name, kind: ["lib"] }],
  dependencies: [],
  ...extra,
});
const pathDep = (name, kind = null) => ({
  name,
  kind,
  req: "*",
  path: `/ws/${name}`,
});

// ---- targets ------------------------------------------------------------

test("classifyTargets: lib-only", () => {
  assert.deepEqual(classifyTargets(pkg("a")), { lib: true, bins: [] });
});

test("classifyTargets: bin-only has no lib", () => {
  const p = pkg("cli", { targets: [{ name: "cli", kind: ["bin"] }] });
  assert.deepEqual(classifyTargets(p), { lib: false, bins: ["cli"] });
});

test("classifyTargets: lib+bin, bins sorted", () => {
  const p = pkg("x", {
    targets: [
      { name: "x", kind: ["lib"] },
      { name: "zeta", kind: ["bin"] },
      { name: "alpha", kind: ["bin"] },
    ],
  });
  assert.deepEqual(classifyTargets(p), { lib: true, bins: ["alpha", "zeta"] });
});

test("classifyTargets: cdylib+rlib is a lib, cdylib alone is not", () => {
  assert.equal(
    classifyTargets(
      pkg("a", { targets: [{ name: "a", kind: ["cdylib", "rlib"] }] }),
    ).lib,
    true,
  );
  assert.equal(
    classifyTargets(pkg("a", { targets: [{ name: "a", kind: ["cdylib"] }] }))
      .lib,
    false,
  );
});

test("classifyTargets: proc-macro is a lib; tests/examples are ignored", () => {
  const p = pkg("m", {
    targets: [
      { name: "m", kind: ["proc-macro"] },
      { name: "it", kind: ["test"] },
      { name: "ex", kind: ["example"] },
    ],
  });
  assert.deepEqual(classifyTargets(p), { lib: true, bins: [] });
});

test("lib-packages / bin-packages cover every package; bins only publishable", () => {
  const out = parseMetadata(
    {
      packages: [
        pkg("lib"),
        pkg("cli", { targets: [{ name: "cli", kind: ["bin"] }] }),
        pkg("tool", {
          publish: [],
          targets: [{ name: "tool", kind: ["bin"] }],
        }),
        pkg("both", {
          targets: [
            { name: "both", kind: ["lib"] },
            { name: "both", kind: ["bin"] },
          ],
        }),
      ],
    },
    { packagesExclude: ["lib"], publishExclude: ["both"] },
  );
  assert.deepEqual(out.libPackages, ["lib", "both"]);
  assert.deepEqual(out.binPackages, ["cli", "tool", "both"]);
  assert.deepEqual(out.bins, [{ package: "cli", bin: "cli" }]);
});

// ---- matrix modes -------------------------------------------------------

const featured = pkg("foo", {
  features: { default: ["a"], a: [], b: [] },
});
const plain = pkg("bar", {
  publish: [],
  targets: [{ name: "bar", kind: ["bin"] }],
});

test("parseMatrixMode: default and validation", () => {
  assert.equal(parseMatrixMode(""), "combined");
  assert.equal(parseMatrixMode("both"), "both");
  assert.throws(() => parseMatrixMode("all"), /matrix-mode/);
});

test("combined mode keeps the legacy matrix strings", () => {
  const out = parseMetadata({ packages: [featured, plain] });
  assert.deepEqual(out.matrix, [
    "--package=foo --features=a",
    "--package=foo --features=b",
    "--package=foo --features=default",
    "--package=bar",
  ]);
});

test("isolated mode: no-default row plus one row per non-default feature", () => {
  const out = parseMetadata(
    { packages: [featured, plain] },
    { matrixMode: "isolated" },
  );
  assert.deepEqual(out.matrix, [
    "--package=foo --no-default-features",
    "--package=foo --no-default-features --features=a",
    "--package=foo --no-default-features --features=b",
    "--package=bar --no-default-features",
  ]);
});

test("both mode: combined then isolated; featureless package not duplicated", () => {
  const out = parseMetadata(
    { packages: [featured, plain] },
    { matrixMode: "both" },
  );
  assert.deepEqual(out.matrix, [
    "--package=foo --features=a",
    "--package=foo --features=b",
    "--package=foo --features=default",
    "--package=foo --no-default-features",
    "--package=foo --no-default-features --features=a",
    "--package=foo --no-default-features --features=b",
    "--package=bar",
  ]);
});

test("isolated mode honors feature and package exclusions", () => {
  const out = parseMetadata(
    { packages: [featured, plain] },
    {
      matrixMode: "isolated",
      matrixExcludePackages: ["bar"],
      matrixExcludeFeatures: { global: new Set(["b"]), byPackage: new Map() },
    },
  );
  assert.deepEqual(out.matrix, [
    "--package=foo --no-default-features",
    "--package=foo --no-default-features --features=a",
  ]);
});

test("matrix-include rows carry package details and match matrix", () => {
  const out = parseMetadata(
    { packages: [featured, plain] },
    { matrixMode: "both" },
  );
  assert.deepEqual(
    out.matrixInclude.map((r) => r.args),
    out.matrix,
  );
  assert.deepEqual(out.matrixInclude[0], {
    package: "foo",
    features: "a",
    args: "--package=foo --features=a",
    mode: "combined",
    lib: true,
    bins: [],
    publish: true,
  });
  assert.deepEqual(out.matrixInclude.at(-1), {
    package: "bar",
    features: "",
    args: "--package=bar",
    mode: "combined",
    lib: false,
    bins: ["bar"],
    publish: false,
  });
  const iso = out.matrixInclude.find(
    (r) => r.mode === "isolated" && r.features === "",
  );
  assert.equal(iso.args, "--package=foo --no-default-features");
});

// ---- dependency ordering ------------------------------------------------

test("buildDepGraph: normal and build path deps count; dev, registry, external don't", () => {
  const g = buildDepGraph({
    packages: [
      pkg("core"),
      pkg("macros"),
      pkg("cli", {
        dependencies: [
          pathDep("core"),
          pathDep("macros", "build"),
          { name: "serde", kind: null, req: "^1" },
          pathDep("outside"),
        ],
      }),
      pkg("tests", {
        dependencies: [{ ...pathDep("cli", "dev"), req: "^0.1.0" }],
      }),
    ],
  });
  assert.deepEqual([...g.get("cli")].sort(), ["core", "macros"]);
  assert.deepEqual([...g.get("tests")], []);
  assert.deepEqual([...g.get("core")], []);
});

test("publishWaves: chain plus siblings", () => {
  // roas-like: roas → {overlay, codegen} → executor → cli
  const g = buildDepGraph({
    packages: [
      pkg("roas"),
      pkg("overlay", { dependencies: [pathDep("roas")] }),
      pkg("codegen", { dependencies: [pathDep("roas")] }),
      pkg("executor", {
        dependencies: [pathDep("overlay"), pathDep("codegen")],
      }),
      pkg("cli", { dependencies: [pathDep("executor"), pathDep("roas")] }),
    ],
  });
  assert.deepEqual(
    publishWaves(["cli", "executor", "codegen", "overlay", "roas"], g),
    [["roas"], ["codegen", "overlay"], ["executor"], ["cli"]],
  );
});

test("publishWaves: dependencies outside the set are ignored", () => {
  const g = buildDepGraph({
    packages: [
      pkg("a"),
      pkg("b", { dependencies: [pathDep("a")] }),
      pkg("c", { dependencies: [pathDep("b")] }),
    ],
  });
  // b isn't being released, so a and c are independent.
  assert.deepEqual(publishWaves(["c", "a"], g), [["a", "c"]]);
});

test("publishWaves: dev-dependency cycle does not block ordering", () => {
  const g = buildDepGraph({
    packages: [
      pkg("foo", { dependencies: [pathDep("foo-macros")] }),
      pkg("foo-macros", {
        dependencies: [{ ...pathDep("foo", "dev"), req: "^0.1.0" }],
      }),
    ],
  });
  assert.deepEqual(publishWaves(["foo", "foo-macros"], g), [
    ["foo-macros"],
    ["foo"],
  ]);
});

test("publishWaves: a real cycle throws instead of looping", () => {
  const g = new Map([
    ["a", new Set(["b"])],
    ["b", new Set(["a"])],
  ]);
  assert.throws(() => publishWaves(["a", "b"], g), /cycle among: a, b/);
});

test("planRelease: publish order, waves, release-order and new-crates", () => {
  const metadata = {
    packages: [
      pkg("nuspec"),
      pkg("cargo-nuspec", { dependencies: [pathDep("nuspec")] }),
    ],
  };
  const plan = planRelease(
    [
      { name: "cargo-nuspec", version: "0.3.2", published: "0.3.1" },
      { name: "nuspec", version: "0.2.0", published: null },
    ],
    metadata,
    DEFAULT_TAG_FORMAT,
  );
  assert.deepEqual(plan, {
    publish: ["nuspec", "cargo-nuspec"],
    waves: [["nuspec"], ["cargo-nuspec"]],
    releaseOrder: ["nuspec/v0.2.0", "cargo-nuspec/v0.3.2"],
    newCrates: ["nuspec"],
  });
});

test("planRelease: empty input", () => {
  assert.deepEqual(planRelease([], { packages: [] }, DEFAULT_TAG_FORMAT), {
    publish: [],
    waves: [],
    releaseOrder: [],
    newCrates: [],
  });
});

// ---- tags ---------------------------------------------------------------

const ws = {
  packages: [
    pkg("nuspec", { version: "0.2.0" }),
    pkg("cargo-nuspec", { version: "0.3.1" }),
    pkg("nuspec-test", { publish: [] }),
  ],
};
const single = {
  packages: [pkg("solo", { version: "1.2.3" }), pkg("priv", { publish: [] })],
};

test("resolveTag: explicit input wins and strips refs/tags/", () => {
  assert.equal(resolveTag("refs/tags/a/v1.0.0", "refs/heads/main"), "a/v1.0.0");
  assert.equal(resolveTag("a/v1.0.0", "refs/tags/b/v2.0.0"), "a/v1.0.0");
});

test("resolveTag: falls back to GITHUB_REF only for tags", () => {
  assert.equal(resolveTag("", "refs/tags/a/v1.0.0"), "a/v1.0.0");
  assert.equal(resolveTag("", "refs/heads/main"), "");
  assert.equal(resolveTag("", "refs/pull/1/merge"), "");
  assert.equal(resolveTag("", undefined), "");
});

test("parseTagFormat: default and validation", () => {
  assert.equal(parseTagFormat(""), "{package}/v{version}");
  assert.equal(parseTagFormat("v{version}"), "v{version}");
  assert.throws(() => parseTagFormat("{package}"), /\{version\}/);
  assert.throws(() => parseTagFormat("{version}-{version}"), /exactly once/);
  assert.throws(
    () => parseTagFormat("{package}-{package}@{version}"),
    /at most once/,
  );
});

test("formatTag substitutes placeholders", () => {
  assert.equal(formatTag("{package}/v{version}", "a", "1.0.0"), "a/v1.0.0");
  assert.equal(formatTag("v{version}", "a", "1.0.0"), "v1.0.0");
});

test("parseTag: <package>/v<version>", () => {
  assert.deepEqual(parseTag("cargo-nuspec/v0.3.1", DEFAULT_TAG_FORMAT, ws), {
    package: "cargo-nuspec",
    version: "0.3.1",
  });
});

test("parseTag: version mismatch fails", () => {
  assert.throws(
    () => parseTag("cargo-nuspec/v0.3.2", DEFAULT_TAG_FORMAT, ws),
    /version 0\.3\.2 does not match cargo-nuspec's Cargo\.toml version 0\.3\.1/,
  );
});

test("parseTag: unknown package fails", () => {
  assert.throws(
    () => parseTag("nope/v0.1.0", DEFAULT_TAG_FORMAT, ws),
    /unknown package "nope"/,
  );
});

test("parseTag: publish = false package fails", () => {
  assert.throws(
    () => parseTag("nuspec-test/v0.1.0", DEFAULT_TAG_FORMAT, ws),
    /not publishable/,
  );
});

test("parseTag: tag not matching the format fails", () => {
  assert.throws(
    () => parseTag("release-2026", DEFAULT_TAG_FORMAT, ws),
    /does not match tag-format/,
  );
  assert.throws(
    () => parseTag("v0.2.0", DEFAULT_TAG_FORMAT, ws),
    /does not match tag-format/,
  );
});

test("parseTag: plain v<version> accepted for a single publishable package", () => {
  assert.deepEqual(parseTag("v1.2.3", DEFAULT_TAG_FORMAT, single), {
    package: "solo",
    version: "1.2.3",
  });
  assert.deepEqual(parseTag("v1.2.3", "v{version}", single), {
    package: "solo",
    version: "1.2.3",
  });
});

test("parseTag: format without {package} needs exactly one publishable package", () => {
  assert.throws(
    () => parseTag("v0.2.0", "v{version}", ws),
    /2 publishable packages/,
  );
});

test("parseTag: hyphenated format splits package names containing -v", () => {
  const m = { packages: [pkg("foo-v2", { version: "1.0.0" })] };
  assert.deepEqual(parseTag("foo-v2-v1.0.0", "{package}-v{version}", m), {
    package: "foo-v2",
    version: "1.0.0",
  });
});

test("parseTag: prerelease versions", () => {
  const m = { packages: [pkg("a", { version: "1.0.0-rc.1" }), pkg("b")] };
  assert.deepEqual(parseTag("a/v1.0.0-rc.1", DEFAULT_TAG_FORMAT, m), {
    package: "a",
    version: "1.0.0-rc.1",
  });
});
