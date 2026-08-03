import { execSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync } from "node:fs";

function pidsOnPort(port) {
  try {
    return execSync(`lsof -ti :${port}`, { encoding: "utf8" })
      .trim()
      .split("\n")
      .filter(Boolean);
  } catch {
    return [];
  }
}

let killed = 0;
for (let port = 8765; port <= 8770; port++) {
  for (const pid of pidsOnPort(port)) {
    try {
      execSync(`kill -9 ${pid}`);
      console.log(`Stopped PID ${pid} on port ${port}`);
      killed += 1;
    } catch (err) {
      console.error(`Could not stop PID ${pid} on port ${port}: ${err.message}`);
    }
  }
}

// Fallback: bash script (sometimes works when node kill does not).
const stopSh = "scripts/stop.sh";
if (existsSync(stopSh)) {
  try {
    chmodSync(stopSh, 0o755);
    execSync(`bash ${stopSh}`, { stdio: "inherit" });
  } catch {
    /* ignore */
  }
}

if (killed === 0) {
  console.log("No servers on ports 8765–8770.");
} else {
  console.log(`Stopped ${killed} server(s).`);
}
