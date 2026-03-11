/**
 * Load .env before any test runs.
 * Loads from project root first, then integrated-tests (allows local overrides).
 */
import { config } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, "..", "..", ".env") });
config({ path: join(__dirname, "..", ".env"), override: true });
