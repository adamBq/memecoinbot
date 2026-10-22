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
  ],
};
