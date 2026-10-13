/**
 * Self-test (docs/roadmap.md, v0 acceptance): replays every MIDI mapping through a fresh mapper,
 * checks the effect (look playing with non-black DMX on its fixtures, group level applied), checks
 * the exclusivity of every exclusive group, measures trigger → rendered frame time, and restores the
 * state it found. Same spirit as the user's own end-to-end MIDI test bench.
 */
import { z } from "zod";
import type { CommandRegistry } from "./registry.js";
import type { DmxEngine } from "../engine/dmx-engine.js";
import { MidiMapper, type Mapping } from "../midi/mapping.js";
import type { MidiMessage } from "../midi/parse.js";
import type { ShowRuntime } from "../show/runtime.js";

export interface SelftestResult {
  total: number;
  passed: number;
  failed: { mapping: string; label: string; reason: string }[];
  exclusivity: { group: string; ok: boolean; detail?: string }[];
  latencyMs: { p50: number; max: number };
}

function messageFor(m: Mapping): MidiMessage {
  const ch = m.input.channel;
  switch (m.input.type) {
    case "note":
      return { type: "noteon", channel: ch, note: m.input.number, velocity: 100 };
    case "cc":
      return { type: "cc", channel: ch, controller: m.input.number, value: 127 };
    case "programchange":
      return { type: "programchange", channel: ch, program: m.input.number };
    case "pitchbend":
      return { type: "pitchbend", channel: ch, value: 16383 };
  }
}

export function registerSelftestCommands(reg: CommandRegistry, engine: DmxEngine, runtime: ShowRuntime, mappings: () => Mapping[]): void {
  const fixturesOfLook = (lookId: string): string[] => {
    const look = runtime.looks.get(lookId);
    if (!look) return [];
    try {
      return [...new Set(runtime.venue.cellTargets(look.canvas).flat().map((t) => t.fixture))];
    } catch {
      return [];
    }
  };
  const litFor = (fixtureIds: string[]): boolean => {
    const buffers = engine.render();
    return fixtureIds.some((id) => {
      const f = runtime.venue.fixtures.get(id);
      const r = runtime.venue.resolve(id);
      if (!f || "error" in r) return false;
      const buf = buffers[f.universe - 1];
      return buf ? r.mode.channels.some((_, off) => buf[f.address - 1 + off]! > 0) : false;
    });
  };

  reg.register({
    name: "selftest.run",
    title: "Auto-test",
    description:
      "Replays every MIDI mapping, checks its effect (look playing with DMX on its fixtures, group level), checks exclusive groups, measures trigger→frame time, then restores the previous state.",
    right: "commands:selftest",
    readOnly: true,
    profiles: ["setup"],
    schema: z.object({}),
    run: async (): Promise<SelftestResult> => {
      const activeBefore = runtime.activeLooks();
      const levelsBefore = new Map(runtime.groups.list().map((g) => [g.id, g.master]));
      const blackoutBefore = engine.isBlackout();
      engine.setBlackout(false);
      const mapper = new MidiMapper();
      const all = mappings();
      mapper.setMappings(all);
      const failed: SelftestResult["failed"] = [];
      const latencies: number[] = [];
      const ctx = { origin: "system" as const, can: () => true };
      try {
        for (const m of all) {
          runtime.stopAll();
          engine.setBlackout(false); // a previous mapping (e.g. a blackout button) must not mask the next ones
          const t0 = performance.now();
          const out = mapper.handle(messageFor(m), m.input.port);
          let reason = out.calls.length ? "" : "aucune commande produite";
          for (const call of out.calls) {
            try {
              await reg.invoke(call.command, call.args, ctx);
            } catch (err) {
              reason = `${call.command} : ${(err as Error).message}`;
            }
            if (reason) break;
            if (call.command === "look.go") {
              const id = String(call.args.id);
              if (!runtime.isActive(id)) reason = `le look ${id} ne joue pas`;
              else if (!litFor(fixturesOfLook(id))) reason = `le look ${id} ne produit aucun DMX`;
            } else if (call.command === "group.level") {
              const g = runtime.groups.get(String(call.args.id));
              if (!g || Math.abs((g.master?.level ?? -1) - Number(call.args.level)) > 0.01) reason = `niveau du groupe ${String(call.args.id)} non appliqué`;
            }
          }
          latencies.push(performance.now() - t0);
          if (reason) failed.push({ mapping: m.id, label: m.label, reason });
        }
        const exclusivity: SelftestResult["exclusivity"] = [];
        for (const g of runtime.groups.list().filter((x) => x.exclusive)) {
          runtime.stopAll();
          let ok = true;
          let detail: string | undefined;
          for (const look of g.members.looks) {
            if (!runtime.looks.get(look)) continue;
            runtime.go(look);
            const playing = g.members.looks.filter((l) => runtime.isActive(l));
            if (playing.length !== 1) {
              ok = false;
              detail = `${playing.length} looks actifs après ${look}`;
              break;
            }
          }
          exclusivity.push({ group: g.id, ok, detail });
        }
        latencies.sort((a, b) => a - b);
        return {
          total: all.length,
          passed: all.length - failed.length,
          failed,
          exclusivity,
          latencyMs: { p50: Math.round((latencies[Math.floor(latencies.length / 2)] ?? 0) * 100) / 100, max: Math.round((latencies.at(-1) ?? 0) * 100) / 100 },
        };
      } finally {
        runtime.stopAll();
        for (const id of activeBefore) runtime.go(id);
        for (const g of runtime.groups.list()) {
          const before = levelsBefore.get(g.id);
          if (JSON.stringify(before) !== JSON.stringify(g.master)) runtime.groups.put({ ...g, master: before });
        }
        engine.setBlackout(blackoutBefore);
      }
    },
  });
}
