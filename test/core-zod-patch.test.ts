import { expect } from "chai";
import { z } from "zod";
import { patchSchema } from "../src/core/zod-patch.js";

describe("patch schemas", () => {
  const Settings = z.object({
    name: z.string().default("Show"),
    level: z.number().min(0).max(1).default(1),
    folders: z
      .array(z.string())
      .default([])
      .transform((l) => l.map((f) => f.trim())),
    note: z.string().optional(),
  });

  it("leaves out what the patch does not give, where partial() would fill in the defaults", () => {
    expect(Settings.partial().parse({ note: "x" })).to.deep.equal({ name: "Show", level: 1, folders: [], note: "x" }); // the trap
    expect(patchSchema(Settings).parse({ note: "x" })).to.deep.equal({ note: "x" });
  });

  it("still checks and transforms what it is given", () => {
    expect(patchSchema(Settings).parse({ folders: [" A "] })).to.deep.equal({ folders: ["A"] });
    expect(() => patchSchema(Settings).parse({ level: 2 })).to.throw();
  });
});
