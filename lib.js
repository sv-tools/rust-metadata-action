import { getInput, info, setOutput } from "@actions/core";
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
  return new Promise((resolve, reject) => {
    const cmd = spawn("cargo", [
      "metadata",
      "--manifest-path=" + manifestPath,
      "--no-deps",
      "--format-version",
      "1",
    ]);

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

export function parseMetadata(metadata) {
  const packages = [];
  const publish = [];
  const matrix = [];
  let rustVersion = null;
  let edition = null;
  for (const pkg of metadata.packages ?? []) {
    packages.push(pkg.name);
    if (isPublishable(pkg)) {
      publish.push(pkg.name);
    }
    const features = Object.keys(pkg.features ?? {});
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
    publish,
    matrix,
    rustVersion: rustVersion ?? "",
    edition: edition ?? "",
  };
}

export function writeOutputs(metadata) {
  const { packages, publish, matrix, rustVersion, edition } =
    parseMetadata(metadata);
  setOutput("metadata", JSON.stringify(metadata));
  setOutput("packages", JSON.stringify(packages));
  setOutput("publish", JSON.stringify(publish));
  setOutput("matrix", JSON.stringify(matrix));
  setOutput("rust-version", rustVersion);
  setOutput("edition", edition);
}

export async function run() {
  const manifestPath = getInput("manifest-path", { required: true });
  ensureToolchain(manifestPath);
  const metadata = await runCargoMetadata(manifestPath);
  writeOutputs(metadata);
}
