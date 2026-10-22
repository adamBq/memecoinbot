import { bootstrap } from "../ops/bootstrap.js";
import { logger } from "../core/logger.js";

const { runner, ledger } = bootstrap();
const shutdown = (sig: string) => {
  logger.info({ sig }, "shutting down");
  runner.stop();
  setTimeout(() => {
    ledger.close();
    process.exit(0);
  }, 1500);
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("unhandledRejection", (err) => logger.error({ err: String(err) }, "unhandledRejection"));

runner.start().catch((err) => {
  logger.fatal({ err: String(err) }, "runner crashed");
  process.exit(1);
});
