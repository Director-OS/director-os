import { describe, expect, it } from "vitest";

import { sharedModule } from "./index.js";

describe("shared module", () => {
  it("exposes initialized status", () => {
    expect(sharedModule.status).toBe("initialized");
  });
});
