import { createServer } from "node:http";
import { aiModule } from "@director-os/ai";
import { authModule } from "@director-os/auth";
import { databaseModule } from "@director-os/database";
import { integrationsModule } from "@director-os/integrations";
import type { DirectorModuleStatus } from "@director-os/shared";
import { sharedModule } from "@director-os/shared";
import { uiModule } from "@director-os/ui";

const port = Number(process.env.DIRECTOR_OS_API_PORT ?? 4000);
export const moduleHealth: DirectorModuleStatus[] = [
  sharedModule,
  authModule,
  databaseModule,
  integrationsModule,
  aiModule,
  uiModule
];

export function createApiServer() {
  return createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          service: "director-os-api",
          modules: moduleHealth
        })
      );
      return;
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ message: "Director OS API foundation is running" }));
  });
}

function startApiServer() {
  const server = createApiServer();
  server.listen(port, () => {
    console.log(`Director OS API listening on port ${port}`);
  });
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  startApiServer();
}
