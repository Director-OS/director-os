import { spawn } from "node:child_process";

function run(command, args, options = {}) {
  const child = spawn(command, args, {
    stdio: "inherit",
    shell: false,
    ...options
  });
  return child;
}

const buildWatcher = run("npm", ["run", "--workspace", "@director-os/web", "build", "--", "--watch"]);
const server = run("node", ["./scripts/serve-mvp.mjs"], {
  env: {
    ...process.env,
    DIRECTOR_OS_WATCH: "1",
    DIRECTOR_OS_OPEN: "1"
  }
});

function shutdown(exitCode = 0) {
  buildWatcher.kill("SIGTERM");
  server.kill("SIGTERM");
  process.exit(exitCode);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

buildWatcher.on("exit", (code) => {
  if (typeof code === "number" && code !== 0) {
    shutdown(code);
  }
});

server.on("exit", (code) => {
  if (typeof code === "number" && code !== 0) {
    shutdown(code);
  }
});
