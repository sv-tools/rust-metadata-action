import { getInput, info, setOutput, warning } from "@actions/core";
import { spawn, spawnSync } from "child_process";
import { dirname, resolve as resolvePath } from "path";

export function ensureToolchain(manifestPath) {
  // rustup 1.28+ no longer auto-installs through the cargo/rustc proxy.
  // `rustup toolchain install` with no toolchain arg installs the active
  // toolchain (whatever rust-toolchain.toml selects), without compiling.
  const cwd = dirname(resolvePath(manifestPath));
  const result = spawnSync(
    "rustup",
    ["toolchain", "install", "--no-self-update"],
    { cwd, encoding: "utf8" },
  );
  if (result.error && result.error.code === "ENOENT") {
    info("rustup not found on PATH; skipping toolchain install");
    return;
  }
  if (result.status !== 0) {
    const stderr = (result.stderr || "").trim();
    throw new Error(
      `rustup failed to install the active toolchain` +
        (stderr ? `: ${stderr}` : ""),
    );
  }
}

export function runCargoMetadata(manifestPath) {
  // Spawn cargo from the manifest's directory so rustup picks up any
  // adjacent rust-toolchain.toml (rustup walks up, not down). Pass the
  // absolute manifest path so a relative input doesn't get re-resolved
  // against the new cwd.
  const absManifestPath = resolvePath(manifestPath);
  const cwd = dirname(absManifestPath);
  return new Promise((resolve, reject) => {
    const cmd = spawn(
      "cargo",
      [
        "metadata",
        "--manifest-path=" + absManifestPath,
        "--no-deps",
        "--format-version",
        "1",
      ],
      { cwd, env: plainEnv() },
    );

    const stdoutChunks = [];
    const stderrChunks = [];
    cmd.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
    cmd.stderr.on("data", (chunk) => stderrChunks.push(chunk));

    cmd.on("error", (error) => {
      reject(new Error(`cargo metadata failed to spawn: ${error.message}`));
    });

    cmd.on("close", (code) => {
      const stderr = Buffer.concat(stderrChunks).toString().trim();
      if (code !== 0) {
        reject(
          new Error(
            `cargo metadata failed (exit code ${code})` +
              (stderr ? `: ${stderr}` : ""),
          ),
        );
        return;
      }
      if (stderr) {
        info(stderr);
      }
      const stdout = Buffer.concat(stdoutChunks).toString();
      try {
        resolve(JSON.parse(stdout));
      } catch (err) {
        reject(
          new Error(`failed to parse cargo metadata output: ${err.message}`),
        );
      }
    });
  });
}

// Force cargo to emit plain text regardless of the workflow's
// CARGO_TERM_COLOR setting. We parse stdout ourselves; ANSI escapes wrap
// the field labels (`\e[1m\e[92mversion:\e[0m 0.6.0`) and break anchored
// regex matches. NO_COLOR is set too as a belt-and-suspenders for any
// non-cargo subprocess that might inherit this.
function plainEnv() {
  return { ...process.env, CARGO_TERM_COLOR: "never", NO_COLOR: "1" };
}

// Cargo's `publish` field semantics:
//   null         → unrestricted (publishable)
//   []           → `publish = false` in Cargo.toml (NOT publishable)
//   ["registry"] → restricted to specific registries (still publishable)
function isPublishable(pkg) {
  return (
    pkg.publish === null ||
    (Array.isArray(pkg.publish) && pkg.publish.length > 0)
  );
}

// Compare two `major.minor[.patch]` strings numerically (so "1.10" > "1.9",
// not the lexicographic opposite). Missing components default to 0.
function compareVersion(a, b) {
  const parse = (v) => v.split(".").map((p) => parseInt(p, 10) || 0);
  const av = parse(a);
  const bv = parse(b);
  for (let i = 0; i < 3; i++) {
    const diff = (av[i] ?? 0) - (bv[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

// Full semver compare per https://semver.org §11. Returns negative if a < b,
// 0 if equal in precedence, positive if a > b. Build metadata (`+...`) is
// ignored; prerelease segments (`-...`) are compared per spec: numeric < non-
// numeric, and a version with a prerelease is lower than the same without.
export function compareSemver(a, b) {
  const stripBuild = (v) => v.split("+")[0];
  const split = (v) => {
    const s = stripBuild(v);
    const i = s.indexOf("-");
    return i === -1
      ? { main: s, pre: null }
      : { main: s.slice(0, i), pre: s.slice(i + 1) };
  };
  const sa = split(a);
  const sb = split(b);
  const parse = (m) => m.split(".").map((p) => parseInt(p, 10) || 0);
  const av = parse(sa.main);
  const bv = parse(sb.main);
  for (let i = 0; i < 3; i++) {
    const diff = (av[i] ?? 0) - (bv[i] ?? 0);
    if (diff !== 0) return diff;
  }
  if (sa.pre === null && sb.pre === null) return 0;
  if (sa.pre === null) return 1;
  if (sb.pre === null) return -1;
  const ap = sa.pre.split(".");
  const bp = sb.pre.split(".");
  for (let i = 0; i < Math.max(ap.length, bp.length); i++) {
    if (ap[i] === undefined) return -1;
    if (bp[i] === undefined) return 1;
    const aNum = /^\d+$/.test(ap[i]);
    const bNum = /^\d+$/.test(bp[i]);
    if (aNum && bNum) {
      const d = parseInt(ap[i], 10) - parseInt(bp[i], 10);
      if (d !== 0) return d;
    } else if (aNum !== bNum) {
      // Numeric identifiers always have lower precedence than alphanumeric.
      return aNum ? -1 : 1;
    } else {
      const c = ap[i] < bp[i] ? -1 : ap[i] > bp[i] ? 1 : 0;
      if (c !== 0) return c;
    }
  }
  return 0;
}

// Pulls the published version from cargo info's stdout. Strips ANSI SGR
// escapes first — `getPublishedVersion` forces NO_COLOR on the spawn, but
// the parser stays robust if anything else (e.g. a future caller) feeds it
// colorized output.
export function parseCargoInfoVersion(stdout) {
  const plain = stdout.replace(/\x1b\[[0-9;]*m/g, "");
  const m = plain.match(/^version:\s*(\S+)/im);
  return m ? m[1] : null;
}

// Run `cargo info <name>` and return the latest published version, or null
// if the package isn't on the registry yet (first publish). Other failures
// reject so callers can surface them.
//
// `--registry` is *always* passed, defaulting to the built-in `crates-io`
// alias. Without it, `cargo info` first probes the workspace at `cwd` and
// returns the *local* crate's version when the name happens to match a
// workspace member — making `local == published` for every candidate and
// silently emptying the publish output. With `--registry`, cargo skips the
// local lookup and queries the named registry directly.
//
// A successful exit with no parseable `version:` line is treated as an
// error, *not* as "first publish" — if cargo's output format ever drifts,
// the caller's catch path will skip the candidate (safe default) instead
// of mass-republishing every crate it can't parse.
export function getPublishedVersion(pkgName, cwd, registry) {
  return new Promise((resolve, reject) => {
    const args = ["info", pkgName, "--registry", registry || "crates-io"];
    const cmd = spawn("cargo", args, { cwd, env: plainEnv() });

    const stdoutChunks = [];
    const stderrChunks = [];
    cmd.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
    cmd.stderr.on("data", (chunk) => stderrChunks.push(chunk));

    cmd.on("error", (error) => {
      reject(new Error(`cargo info failed to spawn: ${error.message}`));
    });

    cmd.on("close", (code) => {
      const stdout = Buffer.concat(stdoutChunks).toString();
      const stderr = Buffer.concat(stderrChunks).toString();
      if (code !== 0) {
        if (/could not find/i.test(stderr)) {
          resolve(null);
          return;
        }
        reject(
          new Error(
            `cargo info ${pkgName} failed (exit code ${code})` +
              (stderr.trim() ? `: ${stderr.trim()}` : ""),
          ),
        );
        return;
      }
      const parsed = parseCargoInfoVersion(stdout);
      if (parsed === null) {
        reject(
          new Error(
            `cargo info ${pkgName} returned no parseable \`version:\` line`,
          ),
        );
        return;
      }
      resolve(parsed);
    });
  });
}

// Query each registry in `registries` for the package's latest version and
// return the highest one found (or null if no registry has the crate).
//
// `pkg.publish` in Cargo.toml may list multiple registries — the crate is
// then publishable to any of them. We can't predict which the user will
// `cargo publish --registry <X>` against, so the conservative answer is
// "is it newer than every place it could land?". Taking the max and
// requiring `local > max` prevents emitting a crate that would hit
// "version already uploaded" on whichever registry the user actually
// targets.
export async function getMaxPublishedVersion(name, cwd, registries) {
  let max = null;
  for (const registry of registries) {
    const v = await getPublishedVersion(name, cwd, registry);
    if (v === null) continue;
    if (max === null || compareSemver(v, max) > 0) max = v;
  }
  return max;
}

// Run `worker(item)` over `items` with at most `limit` concurrent in-flight
// calls. Preserves input order in the returned array.
//
// `cargo info` is cheap CPU-wise but spawns a process and hits the network
// per call. In a 100-crate workspace, `Promise.all(...)` would launch 100
// concurrent processes and 100 simultaneous registry requests, which can
// overwhelm a small runner and trigger rate limits. A small pool keeps
// resource use predictable while still giving real parallelism.
export async function asyncPool(limit, items, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runner = async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await worker(items[i]);
    }
  };
  const workerCount = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workerCount }, runner));
  return results;
}

// Split a comma-separated input into trimmed, non-empty entries. Used for
// every `*-exclude*` input — workflows can write either an inline list
// (`a,b,c`) or use YAML's folded form to span lines, both flatten the same
// way after trimming.
export function parseExcludeList(input) {
  if (!input) return [];
  return input
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// Parse `matrix-exclude-features` entries into two buckets:
//   global    — feature names with no `:` (excluded from every package)
//   byPackage — `<package>:<feature>` entries grouped by package name
// Both halves around the `:` are trimmed (so `foo: nightly` matches a
// `nightly` feature). Empty halves (`:foo`, `bar:`) are dropped.
export function parseExcludeFeatures(input) {
  const global = new Set();
  const byPackage = new Map();
  for (const entry of parseExcludeList(input)) {
    const idx = entry.indexOf(":");
    if (idx === -1) {
      global.add(entry);
      continue;
    }
    const pkg = entry.slice(0, idx).trim();
    const feat = entry.slice(idx + 1).trim();
    if (!pkg || !feat) continue;
    if (!byPackage.has(pkg)) byPackage.set(pkg, new Set());
    byPackage.get(pkg).add(feat);
  }
  return { global, byPackage };
}

export const MATRIX_MODES = ["combined", "isolated", "both"];

// Validate the `matrix-mode` input. Empty means the default (`combined`).
export function parseMatrixMode(input) {
  const mode = (input || "combined").trim();
  if (!MATRIX_MODES.includes(mode)) {
    throw new Error(
      `matrix-mode: expected one of ${MATRIX_MODES.join(", ")}, got "${mode}"`,
    );
  }
  return mode;
}

// Target kinds that make a package a "library" — something `cargo doc`
// documents as a lib and `cargo test --doc` can run doctests for. A
// `cdylib`-only crate is not a lib (no Rust-facing API); `cdylib` + `rlib` is.
const LIB_KINDS = new Set(["lib", "rlib", "dylib", "proc-macro"]);

// Summarize a package's targets: whether it has a library target and the
// (sorted) names of its binary targets.
export function classifyTargets(pkg) {
  const targets = pkg.targets ?? [];
  const lib = targets.some((t) => (t.kind ?? []).some((k) => LIB_KINDS.has(k)));
  const bins = targets
    .filter((t) => (t.kind ?? []).includes("bin"))
    .map((t) => t.name)
    .sort();
  return { lib, bins };
}

// Build the intra-workspace dependency graph used to order publishing:
// package name → Set of workspace package names it depends on.
//
// Only path dependencies on other workspace members count, and only the
// `normal` and `build` kinds — dev-dependencies don't constrain publish
// order (path-only ones are stripped by `cargo publish`, and counting the
// versioned ones would introduce cycles such as `foo-macros` dev-depending
// on `foo`). `dep.name` is the real package name even when the dependency
// is renamed in Cargo.toml.
export function buildDepGraph(metadata) {
  const pkgs = metadata.packages ?? [];
  const names = new Set(pkgs.map((p) => p.name));
  const graph = new Map();
  for (const pkg of pkgs) {
    const deps = new Set();
    for (const dep of pkg.dependencies ?? []) {
      if (dep.kind === "dev") continue;
      if (!dep.path) continue;
      if (!names.has(dep.name) || dep.name === pkg.name) continue;
      deps.add(dep.name);
    }
    graph.set(pkg.name, deps);
  }
  return graph;
}

// Group `names` into dependency waves (Kahn's algorithm on the subgraph
// induced by `names`): wave N contains every package whose in-set
// dependencies all live in waves < N. Packages inside a wave don't depend on
// each other, so they can be released together. Each wave is sorted by name
// for stable output. Dependencies outside `names` are ignored — they're not
// being released, so they're already on the registry.
export function publishWaves(names, graph) {
  const remaining = new Set(names);
  const waves = [];
  while (remaining.size > 0) {
    const wave = [...remaining]
      .filter((n) => [...(graph.get(n) ?? [])].every((d) => !remaining.has(d)))
      .sort();
    if (wave.length === 0) {
      // Cargo itself rejects normal/build dependency cycles, so this is
      // defensive — but never loop forever on malformed metadata.
      throw new Error(
        `dependency cycle among: ${[...remaining].sort().join(", ")}`,
      );
    }
    for (const n of wave) remaining.delete(n);
    waves.push(wave);
  }
  return waves;
}

export const DEFAULT_TAG_FORMAT = "{package}/v{version}";

// Semver core + optional prerelease/build. Kept strict (three numeric
// components) so a format like `{package}-v{version}` can split
// `foo-v2-v1.0.0` unambiguously into `foo-v2` and `1.0.0`.
const VERSION_PATTERN =
  "\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?";

// Validate the `tag-format` input. It must contain `{version}`; `{package}`
// is optional (single-crate repositories tag as plain `v1.2.3`). Each
// placeholder may appear at most once.
export function parseTagFormat(input) {
  const format = (input || DEFAULT_TAG_FORMAT).trim();
  const count = (p) => format.split(p).length - 1;
  if (count("{version}") !== 1) {
    throw new Error(
      `tag-format: must contain "{version}" exactly once, got "${format}"`,
    );
  }
  if (count("{package}") > 1) {
    throw new Error(
      `tag-format: "{package}" may appear at most once, got "${format}"`,
    );
  }
  return format;
}

export function formatTag(format, name, version) {
  return format.replace("{package}", name).replace("{version}", version);
}

function tagFormatRegex(format) {
  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = format
    .split(/(\{package\}|\{version\})/)
    .map((part) => {
      if (part === "{package}") return "(?<package>.+?)";
      if (part === "{version}") return `(?<version>${VERSION_PATTERN})`;
      return escape(part);
    })
    .join("");
  return new RegExp(`^${pattern}$`);
}

// Resolve which tag (if any) the action should parse: the explicit `tag`
// input wins; otherwise `GITHUB_REF` when it points at a tag. Returns the
// bare tag name (no `refs/tags/` prefix) or "" when there's nothing to do.
export function resolveTag(input, githubRef) {
  const raw = (input || "").trim();
  if (raw) return raw.replace(/^refs\/tags\//, "");
  if (githubRef && githubRef.startsWith("refs/tags/")) {
    return githubRef.slice("refs/tags/".length);
  }
  return "";
}

// Parse a release tag against `format` and validate it against the
// workspace. Returns `{ package, version }`; throws if the tag doesn't
// match, names an unknown or `publish = false` package, or carries a
// version that differs from the package's Cargo.toml.
//
// When the format has no `{package}` (or the tag is a plain `v<version>`
// that doesn't match the format), the package is inferred — but only if the
// workspace has exactly one publishable package; anything else would be a
// guess.
export function parseTag(tag, format, metadata) {
  const pkgs = metadata.packages ?? [];
  const publishable = pkgs.filter(isPublishable);
  const inferSingle = () => {
    if (publishable.length !== 1) {
      throw new Error(
        `tag "${tag}" does not name a package and the workspace has ` +
          `${publishable.length} publishable packages — include ` +
          `"{package}" in tag-format`,
      );
    }
    return publishable[0].name;
  };

  let name;
  let version;
  const m = tag.match(tagFormatRegex(format));
  if (m) {
    version = m.groups.version;
    name = m.groups.package ?? inferSingle();
  } else {
    const plain = tag.match(new RegExp(`^v(${VERSION_PATTERN})$`));
    if (!plain || publishable.length !== 1) {
      throw new Error(`tag "${tag}" does not match tag-format "${format}"`);
    }
    version = plain[1];
    name = inferSingle();
  }

  const pkg = pkgs.find((p) => p.name === name);
  if (!pkg) {
    throw new Error(`tag "${tag}": unknown package "${name}"`);
  }
  if (!isPublishable(pkg)) {
    throw new Error(
      `tag "${tag}": package "${name}" is not publishable (publish = false)`,
    );
  }
  if (pkg.version !== version) {
    throw new Error(
      `tag "${tag}": version ${version} does not match ${name}'s ` +
        `Cargo.toml version ${pkg.version}`,
    );
  }
  return { package: name, version };
}

// `options` keys mirror their action input names (camelCased):
//   packagesExclude        — names dropped from `packages` output
//   publishExclude         — names dropped from `publish` output
//   matrixExcludePackages  — names dropped from `matrix` output
//   matrixExcludeFeatures  — { global, byPackage } features dropped from matrix
//   matrixMode             — "combined" (default) | "isolated" | "both"
// Each output's exclusion is independent — excluding a package from `matrix`
// does not remove it from `packages` or `publish`, and so on. Compose them
// to get the behavior you want. `rust-version`/`edition` are computed from
// every package regardless of excludes (they describe the workspace), as are
// `lib-packages`/`bin-packages`. `bins` follows `publish-exclude`, since it
// describes what a release workflow ships.
export function parseMetadata(metadata, options = {}) {
  const packagesExclude = new Set(options.packagesExclude ?? []);
  const publishExclude = new Set(options.publishExclude ?? []);
  const matrixExcludePackages = new Set(options.matrixExcludePackages ?? []);
  const matrixExcludeFeatures = options.matrixExcludeFeatures ?? {
    global: new Set(),
    byPackage: new Map(),
  };
  const matrixMode = options.matrixMode ?? "combined";
  const packages = [];
  const publishCandidates = [];
  const matrixInclude = [];
  const libPackages = [];
  const binPackages = [];
  const bins = [];
  let rustVersion = null;
  let edition = null;
  for (const pkg of metadata.packages ?? []) {
    const targets = classifyTargets(pkg);
    const publishable = isPublishable(pkg);
    if (!packagesExclude.has(pkg.name)) {
      packages.push(pkg.name);
    }
    if (targets.lib) libPackages.push(pkg.name);
    if (targets.bins.length > 0) binPackages.push(pkg.name);
    if (publishable && !publishExclude.has(pkg.name)) {
      for (const bin of targets.bins) bins.push({ package: pkg.name, bin });
      // `publish = ["a", "b", ...]` declares every registry the crate may
      // be published to. We need to query *all* of them and compare against
      // the highest version found, since the user picks the target with
      // `cargo publish --registry <X>` at publish time. `publish = null`
      // means unrestricted → just the default (`crates-io`).
      const registries =
        Array.isArray(pkg.publish) && pkg.publish.length > 0
          ? [...pkg.publish]
          : [null];
      publishCandidates.push({
        name: pkg.name,
        version: pkg.version,
        registries,
      });
    }
    if (!matrixExcludePackages.has(pkg.name)) {
      // Sort so matrix output is stable regardless of cargo's feature
      // emission order (currently a BTreeMap, but not contractually so).
      const allFeatures = Object.keys(pkg.features ?? {}).sort();
      const pkgScoped = matrixExcludeFeatures.byPackage.get(pkg.name);
      const features = allFeatures.filter(
        (f) => !matrixExcludeFeatures.global.has(f) && !pkgScoped?.has(f),
      );
      const row = (mode, args, feature) => ({
        package: pkg.name,
        features: feature,
        args,
        mode,
        lib: targets.lib,
        bins: targets.bins,
        publish: publishable,
      });
      const base = `--package=${pkg.name}`;
      if (matrixMode !== "isolated") {
        if (allFeatures.length === 0) {
          matrixInclude.push(row("combined", base, ""));
        } else {
          // If the package has features but every one of them got excluded,
          // emit nothing for it — the user said "skip these features", not
          // "fall back to no-features mode".
          for (const feature of features) {
            matrixInclude.push(
              row("combined", `${base} --features=${feature}`, feature),
            );
          }
        }
      }
      if (matrixMode !== "combined") {
        // Isolated rows build with default features off: once with nothing
        // enabled, then once per feature on its own. In `both` mode a
        // featureless package already has an equivalent combined row, so
        // the duplicate is skipped.
        if (allFeatures.length > 0 || matrixMode === "isolated") {
          const noDefault = `${base} --no-default-features`;
          matrixInclude.push(row("isolated", noDefault, ""));
          for (const feature of features) {
            if (feature === "default") continue;
            matrixInclude.push(
              row("isolated", `${noDefault} --features=${feature}`, feature),
            );
          }
        }
      }
    }
    if (pkg.rust_version != null) {
      if (
        rustVersion === null ||
        compareVersion(pkg.rust_version, rustVersion) > 0
      ) {
        rustVersion = pkg.rust_version;
      }
    }
    if (pkg.edition != null) {
      // Editions are years ("2015", "2018", "2021", "2024") — simple int compare.
      if (
        edition === null ||
        parseInt(pkg.edition, 10) > parseInt(edition, 10)
      ) {
        edition = pkg.edition;
      }
    }
  }
  return {
    packages,
    publishCandidates,
    matrix: matrixInclude.map((r) => r.args),
    matrixInclude,
    libPackages,
    binPackages,
    bins,
    rustVersion: rustVersion ?? "",
    edition: edition ?? "",
  };
}

// Cap on concurrent `cargo info` invocations. Empirically, ~4 saturates a
// GitHub-hosted runner without triggering registry rate limits.
const PUBLISH_CHECK_CONCURRENCY = 4;

// Filter publish candidates down to those whose local version is strictly
// newer than the registry version. Packages that aren't on any of their
// declared registries are kept (first publish). Network/parse failures are
// surfaced as warnings and the candidate is skipped, so a transient outage
// can't accidentally republish an already-published crate.
//
// Returns `{ name, version, published }` for each kept candidate, where
// `published` is the registry's latest version or null for a first publish.
export async function filterPublishable(candidates, cwd) {
  const resolved = await asyncPool(
    PUBLISH_CHECK_CONCURRENCY,
    candidates,
    async ({ name, version, registries }) => {
      let published;
      try {
        published = await getMaxPublishedVersion(name, cwd, registries);
      } catch (err) {
        warning(`${name}: cargo info failed (${err.message}); skipping`);
        return null;
      }
      if (published === null) {
        info(`${name}: not on registry — including for first publish`);
        return { name, version, published };
      }
      if (compareSemver(version, published) > 0) {
        info(`${name}: ${published} → ${version} (publishable)`);
        return { name, version, published };
      }
      info(`${name}: ${version} <= published ${published} (skipping)`);
      return null;
    },
  );
  return resolved.filter((r) => r !== null);
}

// Verify every name listed in the exclude inputs corresponds to a real
// package / feature in the workspace. Returns an array of error messages —
// empty if everything resolves. Catches typos like
// `matrix-exclude-packages: my-crate` (the actual crate is `mycrate`).
//
// Validation is strict by design: an exclude input that silently matches
// nothing tends to mean the workflow author thought they were filtering a
// crate when they weren't, and the bug shows up months later as
// "why is this thing being published / tested".
export function validateExclusions(metadata, options = {}) {
  const pkgs = metadata.packages ?? [];
  const pkgNames = new Set(pkgs.map((p) => p.name));
  const featuresByPkg = new Map(
    pkgs.map((p) => [p.name, new Set(Object.keys(p.features ?? {}))]),
  );
  // Union of features across the workspace — for validating bare entries
  // in `matrix-exclude-features` (which apply globally rather than to a
  // specific package).
  const allFeatures = new Set();
  for (const set of featuresByPkg.values()) {
    for (const f of set) allFeatures.add(f);
  }
  const errors = [];
  const checkPkgList = (input, names) => {
    for (const name of names ?? []) {
      if (!pkgNames.has(name)) {
        errors.push(`${input}: unknown package "${name}"`);
      }
    }
  };
  checkPkgList("packages-exclude", options.packagesExclude);
  checkPkgList("publish-exclude", options.publishExclude);
  checkPkgList("matrix-exclude-packages", options.matrixExcludePackages);
  const f = options.matrixExcludeFeatures;
  if (f) {
    for (const feat of f.global ?? new Set()) {
      if (!allFeatures.has(feat)) {
        errors.push(
          `matrix-exclude-features: unknown feature "${feat}" — not declared by any package`,
        );
      }
    }
    for (const [pkg, feats] of f.byPackage ?? new Map()) {
      if (!pkgNames.has(pkg)) {
        errors.push(`matrix-exclude-features: unknown package "${pkg}"`);
        continue;
      }
      const decl = featuresByPkg.get(pkg);
      for (const feat of feats) {
        if (!decl.has(feat)) {
          errors.push(
            `matrix-exclude-features: package "${pkg}" does not declare feature "${feat}"`,
          );
        }
      }
    }
  }
  return errors;
}

// Order the publishable set by dependency and derive the release-related
// views of it. Pure (no I/O) so it can be unit-tested; `resolved` is what
// `filterPublishable` returns.
export function planRelease(resolved, metadata, tagFormat) {
  const byName = new Map(resolved.map((r) => [r.name, r]));
  const waves = publishWaves([...byName.keys()], buildDepGraph(metadata));
  const publish = waves.flat();
  return {
    publish,
    waves,
    releaseOrder: publish.map((n) =>
      formatTag(tagFormat, n, byName.get(n).version),
    ),
    newCrates: publish.filter((n) => byName.get(n).published === null),
  };
}

export async function writeOutputs(metadata, cwd, options = {}) {
  const parsed = parseMetadata(metadata, options);
  const tagFormat = options.tagFormat ?? DEFAULT_TAG_FORMAT;
  const resolved = await filterPublishable(parsed.publishCandidates, cwd);
  const release = planRelease(resolved, metadata, tagFormat);

  for (const name of release.newCrates) {
    warning(
      `${name} is not on the registry yet. crates.io trusted publishing ` +
        `cannot create new crates — publish the first version manually ` +
        `before tagging.`,
    );
  }
  const tag = options.tag;
  if (
    tag &&
    parsed.publishCandidates.some((c) => c.name === tag.package) &&
    !release.publish.includes(tag.package)
  ) {
    warning(
      `tagged ${tag.package} ${tag.version} is not ahead of the registry ` +
        `(already published, or the registry check failed); it is not in ` +
        `the publish output`,
    );
  }

  setOutput("metadata", JSON.stringify(metadata));
  setOutput("packages", JSON.stringify(parsed.packages));
  setOutput("publish", JSON.stringify(release.publish));
  setOutput("publish-waves", JSON.stringify(release.waves));
  setOutput("release-order", JSON.stringify(release.releaseOrder));
  setOutput("new-crates", JSON.stringify(release.newCrates));
  setOutput("tag-package", tag?.package ?? "");
  setOutput("tag-version", tag?.version ?? "");
  setOutput("matrix", JSON.stringify(parsed.matrix));
  setOutput("matrix-include", JSON.stringify(parsed.matrixInclude));
  setOutput("lib-packages", JSON.stringify(parsed.libPackages));
  setOutput("bin-packages", JSON.stringify(parsed.binPackages));
  setOutput("bins", JSON.stringify(parsed.bins));
  setOutput("rust-version", parsed.rustVersion);
  setOutput("edition", parsed.edition);
}

export async function run() {
  const manifestPath = getInput("manifest-path");
  const packagesExclude = parseExcludeList(getInput("packages-exclude"));
  const publishExclude = parseExcludeList(getInput("publish-exclude"));
  const matrixExcludePackages = parseExcludeList(
    getInput("matrix-exclude-packages"),
  );
  const matrixExcludeFeatures = parseExcludeFeatures(
    getInput("matrix-exclude-features"),
  );
  const matrixMode = parseMatrixMode(getInput("matrix-mode"));
  const tagFormat = parseTagFormat(getInput("tag-format"));
  const tagName = resolveTag(getInput("tag"), process.env.GITHUB_REF);
  ensureToolchain(manifestPath);
  const metadata = await runCargoMetadata(manifestPath);
  const errors = validateExclusions(metadata, {
    packagesExclude,
    publishExclude,
    matrixExcludePackages,
    matrixExcludeFeatures,
  });
  if (errors.length > 0) {
    // Fail loudly before writing any outputs — a typo in an exclude input
    // would otherwise silently widen the matrix / publish set.
    throw new Error("Invalid exclusion inputs:\n  " + errors.join("\n  "));
  }
  // Validate the release tag before any registry queries: a mismatched tag
  // must stop the release, not just produce odd outputs.
  const tag = tagName ? parseTag(tagName, tagFormat, metadata) : null;
  if (tag) info(`release tag ${tagName}: ${tag.package} ${tag.version}`);
  const options = {
    packagesExclude,
    publishExclude,
    matrixExcludePackages,
    matrixExcludeFeatures,
    matrixMode,
    tagFormat,
    tag,
  };
  const cwd = dirname(resolvePath(manifestPath));
  await writeOutputs(metadata, cwd, options);
}
