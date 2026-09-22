import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { generate } from "../../scripts/gen-types.mjs";

/** CLAUDE.md: types are generated from FastAPI's OpenAPI schema, never hand-written. If
 * web/openapi.json changes without `npm run types`, the console compiles against a stale API. */
describe("generated API types", () => {
  it("match web/openapi.json", async () => {
    const committed = readFileSync(resolve(import.meta.dirname, "schema.d.ts"), "utf8").replace(
      /\r\n/g,
      "\n",
    );
    expect(committed, "src/api/schema.d.ts is stale; run `make types`").toBe(await generate());
  });
});
