import { getInput, setOutput, setFailed } from "@actions/core";
import { spawn } from "child_process";

async function run() {
  const manifestPath = getInput("manifest-path", { required: true });
  const cmd = spawn("cargo", [
    "metadata",
    "--manifest-path=" + manifestPath,
    "--no-deps",
    "--format-version",
    "1",
  ]);

  cmd.stderr.on("data", (data) => {
    setFailed("Cargo metadata failed: " + data.toString().trim());
  });

  cmd.on("error", (error) => {
    setFailed("cargo metadata failed: " + error.message);
  });

  cmd.stdout.on("data", (data) => {
    setActionOutput(JSON.parse(data.toString()));
  });
}

function setActionOutput(metadata) {
  setOutput("metadata", JSON.stringify(metadata));
  if (metadata.hasOwnProperty("packages")) {
    let allPackages = [];
    let packagesToPublish = [];
    let matrix = [];
    metadata.packages.forEach((pkg) => {
      allPackages.push(pkg.name);
      if (pkg.hasOwnProperty("publish") && pkg.publish !== false) {
        packagesToPublish.push(pkg.name);
      }
      if (pkg.hasOwnProperty("features")) {
        const names = Object.getOwnPropertyNames(pkg.features);
        if (names.length === 0) {
          matrix.push(`--package=${pkg.name}`);
        } else {
          names.forEach((feature) => {
            matrix.push(`--package=${pkg.name} --features=${feature}`);
          });
        }
      }
    });
    setOutput("packages", JSON.stringify(allPackages));
    setOutput("publish", JSON.stringify(packagesToPublish));
    setOutput("matrix", JSON.stringify(matrix));
  }
}

try {
  await run();
} catch (error) {
  setFailed(error.message);
}
