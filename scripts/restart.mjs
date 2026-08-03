import { spawnSync } from "node:child_process";

console.log("Stopping old servers…");
spawnSync("node", ["scripts/stop.mjs"], { stdio: "inherit" });
console.log("Starting Historia on http://127.0.0.1:8765 …");
const result = spawnSync(".venv/bin/python", ["run.py"], { stdio: "inherit" });
process.exit(result.status ?? 1);
