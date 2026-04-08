import { runConfigBootstrap } from "./bootstrap.js";

runConfigBootstrap().catch((err) => {
  console.error(err);
  process.exit(1);
});
