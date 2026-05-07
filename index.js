import { setFailed } from "@actions/core";
import { run } from "./lib.js";

try {
  await run();
} catch (error) {
  setFailed(error.message);
}
