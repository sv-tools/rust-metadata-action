import { getInput, info, setOutput } from "@actions/core";
import { spawn, spawnSync } from "child_process";
import { dirname, resolve as resolvePath } from "path";

export function ensureToolchain(manifestPath) {
  // rustup 1.28+ no longer auto-installs the toolchain pinned in
  // rust-toolchain.toml when the cargo/rustc proxy is invoked. Running
  // `rustup toolchain install` with no toolchain argument installs the
  // *active* toolchain (i.e. whatever rust-toolchain.toml in the manifest's
  // directory selects), without compiling anything.
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

export function parseMetadata(metadata) {
  const packages = [];
  const publish = [];
  const matrix = [];
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
  }
  return { packages, publish, matrix };
}

export function writeOutputs(metadata) {
  const { packages, publish, matrix } = parseMetadata(metadata);
  setOutput("metadata", JSON.stringify(metadata));
  setOutput("packages", JSON.stringify(packages));
  setOutput("publish", JSON.stringify(publish));
  setOutput("matrix", JSON.stringify(matrix));
}

export async function run() {
  const manifestPath = getInput("manifest-path", { required: true });
  ensureToolchain(manifestPath);
  const metadata = await runCargoMetadata(manifestPath);
  writeOutputs(metadata);
}
