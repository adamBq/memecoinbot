import pino from "pino";

const level = process.env.LOG_LEVEL ?? "info";
const pretty = process.env.LOG_PRETTY === "1" || (process.stdout.isTTY && process.env.NODE_ENV !== "production");

export const logger = pino(
  { level, base: { app: "memecoinbot" } },
  pretty ? pino.transport({ target: "pino-pretty", options: { colorize: true, translateTime: "SYS:standard" } }) : undefined,
);
