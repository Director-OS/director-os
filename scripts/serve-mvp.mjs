import { createReadStream, readFileSync, watch } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { exec } from "node:child_process";

const host = "127.0.0.1";
const requestedPort = Number(process.env.DIRECTOR_OS_WEB_PORT ?? 4173);
const rootDir = process.cwd();
const enableWatch = process.env.DIRECTOR_OS_WATCH === "1";
const autoOpen = process.env.DIRECTOR_OS_OPEN === "1";

const liveClients = new Set();

const contentTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "application/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".ico", "image/x-icon"]
]);

function createStaticServer() {
  return createServer(async (req, res) => {
    try {
      if (enableWatch && req.url?.startsWith("/__director_hmr")) {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive"
        });
        res.write(`data: connected\n\n`);
        liveClients.add(res);
        req.on("close", () => {
          liveClients.delete(res);
        });
        return;
      }

      const urlPath = req.url ? decodeURIComponent(req.url.split("?")[0]) : "/";
      const relativePath = urlPath === "/" ? "index.html" : urlPath.replace(/^\//, "");
      const safePath = normalize(relativePath).replace(/^\.\.(\/|\\|$)/, "");
      const filePath = join(rootDir, safePath);
      const metadata = await stat(filePath);

      if (!metadata.isFile()) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Not found");
        return;
      }

      const extension = extname(filePath).toLowerCase();
      const contentType = contentTypes.get(extension) ?? "application/octet-stream";

      if (enableWatch && extension === ".html") {
        const html = readFileSync(filePath, "utf8");
        const injected = html.replace(
          "</body>",
          `<script>
const source = new EventSource('/__director_hmr');
source.addEventListener('message', (event) => {
  if (event.data === 'reload') {
    location.reload();
  }
});
</script></body>`
        );
        res.writeHead(200, { "Content-Type": contentType });
        res.end(injected);
        return;
      }

      res.writeHead(200, { "Content-Type": contentType });
      createReadStream(filePath).pipe(res);
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
    }
  });
}

function notifyReload() {
  for (const client of liveClients) {
    client.write("data: reload\n\n");
  }
}

function startWatchers() {
  if (!enableWatch) {
    return;
  }
  const files = ["index.html", "styles.css", "apps/web/dist/main.js"];
  for (const relative of files) {
    const target = join(rootDir, relative);
    try {
      watch(target, { persistent: true }, () => {
        notifyReload();
      });
    } catch {
      // ignore unavailable paths during startup; watcher is best effort
    }
  }
}

function openInBrowser(url) {
  if (!autoOpen) {
    return;
  }
  exec(`open '${url}'`);
}

function listenWithFallback(port) {
  const server = createStaticServer();

  server.once("error", (error) => {
    if (error && error.code === "EADDRINUSE") {
      console.log(`Port ${port} is busy, retrying on ${port + 1}...`);
      listenWithFallback(port + 1);
      return;
    }

    console.error("Failed to start Director Intake MVP server:", error);
    process.exitCode = 1;
  });

  server.listen(port, host, () => {
    console.log(`Director Intake MVP available at http://${host}:${port}`);
    startWatchers();
    openInBrowser(`http://${host}:${port}`);
  });
}

listenWithFallback(requestedPort);
