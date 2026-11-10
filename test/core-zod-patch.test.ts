import { expect } from "chai";
import { z } from "zod";
import { patchSchema } from "../src/core/zod-patch.js";
import { ShowSettingsSchema } from "../src/plugins/light/show/model.js";

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

  it("finds the default under optional, nullable, readonly and prefault too", () => {
    const Wrapped = z.object({ a: z.number().default(1).optional(), b: z.string().default("x").nullable(), c: z.array(z.string()).default([]).readonly(), d: z.string().prefault("y") });
    expect(Wrapped.partial().parse({})).to.not.deep.equal({});
    expect(patchSchema(Wrapped).parse({})).to.deep.equal({});
    expect(patchSchema(Wrapped).parse({ b: null })).to.deep.equal({ b: null });
  });

  it("produces nothing for an empty patch of the show settings, the schema it guards today", () => {
    expect(patchSchema(ShowSettingsSchema).parse({})).to.deep.equal({});
  });

  it("still checks and transforms what it is given", () => {
    expect(patchSchema(Settings).parse({ folders: [" A "] })).to.deep.equal({ folders: ["A"] });
    expect(() => patchSchema(Settings).parse({ level: 2 })).to.throw();
  });
});
