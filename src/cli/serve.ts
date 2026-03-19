import type { HarnessConfig } from "../config.js";
import { formatError } from "../errors.js";

export async function cliServe(config: HarnessConfig, port: number, host: string): Promise<void> {
  const { loadAccessConfig } = await import("../access.js");
  const { startServer } = await import("../serve.js");

  const access = loadAccessConfig();

  if (access.users.length === 0) {
    console.error("Warning: No tokens defined in ~/.mastersof-ai/access.yaml");
    console.error("All API requests will be rejected. Create access.yaml to enable access.");
    console.error("");
  }

  try {
    await startServer({ port, host, config, access });
  } catch (err) {
    console.error(formatError(err));
    process.exit(1);
  }
}
