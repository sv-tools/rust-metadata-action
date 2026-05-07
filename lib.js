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
      { cwd },
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

// Pulls the published version from cargo info's stdout.
export function parseCargoInfoVersion(stdout) {
  const m = stdout.match(/^version:\s*(\S+)/im);
  return m ? m[1] : null;
}

// Run `cargo info <name>` and return the latest published version, or null
// if the package isn't on the registry yet (first publish). Other failures
// reject so callers can surface them.
export function getPublishedVersion(pkgName, cwd, registry) {
  return new Promise((resolve, reject) => {
    const args = ["info", pkgName];
    if (registry) {
      args.push("--registry", registry);
    }
    const cmd = spawn("cargo", args, { cwd });

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
      resolve(parseCargoInfoVersion(stdout));
    });
  });
}

export function parseMetadata(metadata) {
  const packages = [];
  const publishCandidates = [];
  const matrix = [];
  let rustVersion = null;
  let edition = null;
  for (const pkg of metadata.packages ?? []) {
    packages.push(pkg.name);
    if (isPublishable(pkg)) {
      // `publish = ["my-registry", ...]` restricts where the crate may go;
      // pick the first entry as the registry to query. `publish = null`
      // (unrestricted) maps to the default registry, so leave it unset.
      const registry =
        Array.isArray(pkg.publish) && pkg.publish.length > 0
          ? pkg.publish[0]
          : null;
      publishCandidates.push({
        name: pkg.name,
        version: pkg.version,
        registry,
      });
    }
    // Sort so matrix output is stable regardless of cargo's feature
    // emission order (currently a BTreeMap, but not contractually so).
    const features = Object.keys(pkg.features ?? {}).sort();
    if (features.length === 0) {
      matrix.push(`--package=${pkg.name}`);
    } else {
      for (const feature of features) {
        matrix.push(`--package=${pkg.name} --features=${feature}`);
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
    matrix,
    rustVersion: rustVersion ?? "",
    edition: edition ?? "",
  };
}

// Filter publish candidates down to those whose local version is strictly
// newer than the registry version. Packages that aren't on the registry yet
// are kept (first publish). Network/parse failures are surfaced as warnings
// and the candidate is skipped, so a transient outage can't accidentally
// republish an already-published crate.
export async function filterPublishable(candidates, cwd) {
  const checks = candidates.map(async ({ name, version, registry }) => {
    let published;
    try {
      published = await getPublishedVersion(name, cwd, registry);
    } catch (err) {
      warning(`${name}: cargo info failed (${err.message}); skipping`);
      return null;
    }
    if (published === null) {
      info(`${name}: not on registry — including for first publish`);
      return name;
    }
    if (compareSemver(version, published) > 0) {
      info(`${name}: ${published} → ${version} (publishable)`);
      return name;
    }
    info(`${name}: ${version} <= published ${published} (skipping)`);
    return null;
  });
  const resolved = await Promise.all(checks);
  return resolved.filter((name) => name !== null);
}

export async function writeOutputs(metadata, cwd) {
  const { packages, publishCandidates, matrix, rustVersion, edition } =
    parseMetadata(metadata);
  const publish = await filterPublishable(publishCandidates, cwd);
  setOutput("metadata", JSON.stringify(metadata));
  setOutput("packages", JSON.stringify(packages));
  setOutput("publish", JSON.stringify(publish));
  setOutput("matrix", JSON.stringify(matrix));
  setOutput("rust-version", rustVersion);
  setOutput("edition", edition);
}

export async function run() {
  const manifestPath = getInput("manifest-path");
  ensureToolchain(manifestPath);
  const metadata = await runCargoMetadata(manifestPath);
  const cwd = dirname(resolvePath(manifestPath));
  await writeOutputs(metadata, cwd);
}
