import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

if (!existsSync("package.json") || !existsSync(".venv/bin/python")) {
  console.error(`
Cannot start Historia from this folder.

Run these commands first:

  cd ~/Downloads/historia
  npm run dev

(You are currently in: ${process.cwd()})
`);
  process.exit(1);
}

console.log("Checking for old servers…");
spawnSync("node", ["scripts/stop.mjs"], { stdio: "inherit" });

const result = spawnSync(".venv/bin/python", ["run.py"], { stdio: "inherit" });
process.exit(result.status ?? 1);
