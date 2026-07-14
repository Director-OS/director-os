import { createServer } from "node:http";
import { aiModule } from "@director-os/ai";
import { authModule } from "@director-os/auth";
import { databaseModule } from "@director-os/database";
import { integrationsModule } from "@director-os/integrations";
import { sharedModule } from "@director-os/shared";
import { uiModule } from "@director-os/ui";

const port = Number(process.env.DIRECTOR_OS_API_PORT ?? 4000);
const moduleHealth = [
  sharedModule,
  authModule,
  databaseModule,
  integrationsModule,
  aiModule,
  uiModule
];

const server = createServer((req, res) => {
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

server.listen(port, () => {
  console.log(`Director OS API listening on port ${port}`);
});
