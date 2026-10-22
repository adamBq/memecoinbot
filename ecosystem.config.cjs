module.exports = {
  apps: [
    {
      name: "memecoinbot",
      script: "node_modules/.bin/tsx",
      args: "src/cli/run.ts",
      cwd: __dirname,
      interpreter: "none",
      autorestart: true,
      max_restarts: 50,
      restart_delay: 5000,
      env: { NODE_ENV: "production", LOG_PRETTY: "0" },
      out_file: "logs/out.log",
      error_file: "logs/err.log",
      merge_logs: true,
      time: true,
    },
    {
      // Read-only dashboard at http://127.0.0.1:4777 (serves ui/dist, never writes to the ledger).
      name: "memecoinbot-ui",
      script: "node_modules/.bin/tsx",
      args: "src/cli/ui.ts",
      cwd: __dirname,
      interpreter: "none",
      autorestart: true,
      restart_delay: 3000,
      env: { NODE_ENV: "production", LOG_PRETTY: "0", UI_PORT: "4777", UI_HOST: "127.0.0.1" },
      out_file: "logs/ui.out.log",
      error_file: "logs/ui.err.log",
      merge_logs: true,
      time: true,
    },
    {
      // Keeps the Mac from idle-sleeping while the bot runs (display may still sleep).
      name: "memecoinbot-keepawake",
      script: "/usr/bin/caffeinate",
      args: "-i -s",
      interpreter: "none",
      autorestart: true,
    },
  ],
};
