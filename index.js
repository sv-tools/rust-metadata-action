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
    let allCrates = [];
    let cratesToPublish = [];
    let features = {};
    metadata.packages.forEach((pkg) => {
      allCrates.push(pkg.name);
      if (pkg.hasOwnProperty("publish") && pkg.publish !== false) {
        cratesToPublish.push(pkg.name);
      }
      if (pkg.hasOwnProperty("features")) {
        features[pkg.name] = Object.getOwnPropertyNames(pkg.features);
      }
    });
    setOutput("crates", JSON.stringify(allCrates));
    setOutput("publish", JSON.stringify(cratesToPublish));
    setOutput("features", JSON.stringify(features));
  }
}

try {
  await run();
} catch (error) {
  setFailed(error.message);
}
