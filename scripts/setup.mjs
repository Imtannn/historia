import { existsSync } from "node:fs";
import { execSync } from "node:child_process";

const python = process.env.PYTHON || "python3.12";

if (!existsSync(".venv")) {
  console.log(`Creating venv with ${python}…`);
  execSync(`${python} -m venv .venv`, { stdio: "inherit" });
}

console.log("Installing Python dependencies…");
execSync(".venv/bin/pip install -r requirements.txt", { stdio: "inherit" });
console.log("Done. Run: npm run dev");
