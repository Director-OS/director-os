import { createServer } from "node:http";

const port = Number(process.env.DIRECTOR_OS_API_PORT ?? 4000);

const server = createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", service: "director-os-api" }));
    return;
  }

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ message: "Director OS API foundation is running" }));
});

server.listen(port, () => {
  console.log(`Director OS API listening on port ${port}`);
});
