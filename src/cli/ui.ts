/** `npm run ui`: start the read-only dashboard server on UI_HOST:UI_PORT (default 127.0.0.1:4777). */
import { logger } from "../core/logger.js";
import { main } from "../ui/server.js";

main().catch((err: unknown) => {
  logger.fatal({ err: err instanceof Error ? err.stack ?? err.message : String(err) }, "ui: failed to start");
  process.exit(1);
});
