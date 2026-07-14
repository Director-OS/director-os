import { afterEach, describe, expect, it } from "vitest";

import { createApiServer, moduleHealth } from "./index.js";

const serversToClose: Array<ReturnType<typeof createApiServer>> = [];

afterEach(async () => {
  await Promise.all(
    serversToClose.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((err) => {
            if (err) {
              reject(err);
              return;
            }
            resolve();
          });
        })
    )
  );
});

describe("api server", () => {
  it("returns health payload with module states", async () => {
    const server = createApiServer();
    serversToClose.push(server);

    await new Promise<void>((resolve, reject) => {
      server.listen(0, () => resolve());
      server.on("error", reject);
    });

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected TCP address");
    }

    const response = await fetch(`http://127.0.0.1:${address.port}/health`);
    const payload = (await response.json()) as {
      status: string;
      service: string;
      modules: unknown;
    };

    expect(response.status).toBe(200);
    expect(payload.status).toBe("ok");
    expect(payload.service).toBe("director-os-api");
    expect(payload.modules).toEqual(moduleHealth);
  });
});
