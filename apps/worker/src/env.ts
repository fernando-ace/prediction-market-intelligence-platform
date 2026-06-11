import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

const workerSrcDir = dirname(fileURLToPath(import.meta.url));
const workspaceRootEnv = resolve(workerSrcDir, "../../..", ".env");
const cwdEnv = resolve(process.cwd(), ".env");

config({ path: workspaceRootEnv });
if (cwdEnv !== workspaceRootEnv) {
  config({ path: cwdEnv });
}
