/**
 * Self-test (docs/roadmap.md, v0 acceptance): replays every MIDI mapping through a fresh mapper,
 * checks the effect (look playing with non-black DMX on its fixtures, group level applied), checks
 * the exclusivity of every exclusive group, measures trigger → rendered frame time, optionally
 * measures each look's cadence on the real output in real time, and restores the state it found.
 * Same spirit as the user's own end-to-end MIDI test bench.
 */
import { z } from "zod";
import type { CommandRegistry } from "./registry.js";
import type { DmxEngine } from "../engine/dmx-engine.js";
import { MidiMapper, type Mapping } from "../midi/mapping.js";
import type { MidiMessage } from "../midi/parse.js";
import type { ShowRuntime } from "../show/runtime.js";
import { say } from "../../../core/lang.js";

export interface SelftestResult {
  total: number;
  passed: number;
  failed: { mapping: string; label: string; reason: string }[];
  exclusivity: { group: string; ok: boolean; detail?: string }[];
  latencyMs: { p50: number; max: number };
  /** Real-time cadence of the looks (with `cadence: true`), at the tempo of the moment. */
  cadence?: { bpm: number; looks: CadenceCheck[] };
}

export interface CadenceCheck {
  look: string;
  expectedMs: number;
  measuredMs?: number;
  ok: boolean;
  detail?: string;
}

/**
 * Checks step-change times against an expected step length: every interval must be a whole number
 * of steps (two identical steps in a row look like one long step) within the tolerance.
 * Pure: takes the change timestamps (ms).
 */
export function checkCadence(changes: number[], expectedMs: number, toleranceMs = Math.max(25, expectedMs * 0.05)): Omit<CadenceCheck, "look"> {
  const intervals = changes.slice(1).map((t, i) => t - changes[i]!);
  if (intervals.length < 2) return { expectedMs, ok: false, detail: say(`${changes.length} changement(s) observé(s) : pas assez pour mesurer`, `${changes.length} change(s) seen: not enough to measure`) };
  const perStep = intervals.map((d) => d / Math.max(1, Math.round(d / expectedMs)));
  perStep.sort((a, b) => a - b);
  const measuredMs = Math.round(perStep[Math.floor(perStep.length / 2)]! * 10) / 10;
  // The cadence is judged on the median (a wrong tempo or multiplier shifts it); one isolated hiccup
  // (a busy machine delaying a frame) is reported but tolerated, two or more fail.
  // Deviation of each change from the ideal grid (one late frame = one hiccup, not two bad intervals).
  const step = measuredMs;
  const offsets = changes.map((t) => t - Math.round((t - changes[0]!) / step) * step);
  const base = [...offsets].sort((a, b) => a - b)[Math.floor(offsets.length / 2)]!;
  const hiccups = offsets.map((o) => Math.abs(o - base)).filter((d) => d > toleranceMs);
  const medianOk = Math.abs(measuredMs - expectedMs) <= toleranceMs;
  const ok = medianOk && hiccups.length <= 1;
  const tol = say(`tolérance ${Math.round(toleranceMs)} ms`, `tolerance ${Math.round(toleranceMs)} ms`);
  const detail = !medianOk ? say(`cadence ${measuredMs} ms au lieu de ${Math.round(expectedMs)} (${tol})`, `rate ${measuredMs} ms instead of ${Math.round(expectedMs)} (${tol})`) : hiccups.length > 1 ? say(`${hiccups.length} à-coups jusqu'à ${Math.round(Math.max(...hiccups))} ms (${tol})`, `${hiccups.length} hiccups up to ${Math.round(Math.max(...hiccups))} ms (${tol})`) : hiccups.length === 1 ? say(`un à-coup isolé de ${Math.round(hiccups[0]!)} ms, toléré`, `a single hiccup of ${Math.round(hiccups[0]!)} ms, tolerated`) : undefined;
  return { expectedMs: Math.round(expectedMs * 10) / 10, measuredMs, ok, ...(detail ? { detail } : {}) };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

export function registerSelftestCommands(reg: CommandRegistry, engine: DmxEngine, runtime: ShowRuntime, mappings: () => Mapping[], bpm: () => number = () => 120): void {
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

  /** Snapshot of a look's fixtures on the real output. */
  const snapshot = (fixtureIds: string[]): string => {
    const buffers = engine.render();
    return fixtureIds
      .map((id) => {
        const f = runtime.venue.fixtures.get(id);
        const r = runtime.venue.resolve(id);
        const buf = f && buffers[f.universe - 1];
        return !f || "error" in r || !buf ? "" : Array.from(buf.subarray(f.address - 1, f.address - 1 + r.mode.channels.length)).join(",");
      })
      .join("|");
  };

  /** Plays a look alone and times its step changes on the output (real time, ~4 steps). */
  const measureLook = async (lookId: string, tempoBpm: number): Promise<CadenceCheck> => {
    const look = runtime.looks.get(lookId)!;
    const every = look.timing.every;
    const expectedMs = "seconds" in every ? every.seconds * 1000 : (every.beats * 60_000) / tempoBpm;
    if (look.timing.attack > 0.5) return { look: lookId, expectedMs, ok: true, detail: say("fondu (attaque) de plus d'un demi-pas : cadence non mesurable par changement, ignoré", "fade (attack) longer than half a step: rate not measurable by changes, skipped") };
    if (expectedMs > 4000) return { look: lookId, expectedMs, ok: true, detail: say("pas de plus de 4 s : ignoré", "steps longer than 4 s: skipped") };
    runtime.stopAll();
    runtime.go(lookId);
    // the entry fade changes the output on every frame: measure the steps once it is over
    if (look.timing.entryFade > 0) await sleep(look.timing.entryFade * 1000 + 50);
    const fixtures = fixturesOfLook(lookId);
    const changes: number[] = [];
    let last = snapshot(fixtures);
    const until = performance.now() + expectedMs * 5.5 + 100;
    // A step starts with its first change; the fade (attack) that follows is part of the same step.
    const guardMs = expectedMs * (look.timing.attack + 0.15);
    while (performance.now() < until && changes.length < 5) {
      await sleep(2);
      const now = snapshot(fixtures);
      const at = performance.now();
      if (now !== last && (!changes.length || at - changes.at(-1)! > guardMs)) changes.push(at);
      last = now;
    }
    runtime.stop(lookId);
    return { look: lookId, ...checkCadence(changes, expectedMs) };
  };

  reg.register({
    name: "selftest.run",
    title: "Auto-test",
    description:
      "Replays every MIDI mapping, checks its effect (look playing with DMX on its fixtures, group level), checks exclusive groups, measures trigger→frame time, then restores the previous state. With cadence: true, also plays each look (or the given ones) alone and measures its step cadence on the real output against the current tempo (about 4 steps per look: takes a while).",
    right: "commands:selftest",
    profiles: ["setup"],
    schema: z.object({ cadence: z.boolean().default(false), looks: z.array(z.string()).optional() }),
    run: async ({ cadence, looks }): Promise<SelftestResult> => {
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
              if (!g || Math.abs((g.master?.level ?? -1) - Number(call.args.level)) > 0.01) reason = say(`niveau du groupe ${String(call.args.id)} non appliqué`, `level of group ${String(call.args.id)} not applied`);
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
              detail = say(`${playing.length} looks actifs après ${look}`, `${playing.length} looks playing after ${look}`);
              break;
            }
          }
          exclusivity.push({ group: g.id, ok, detail });
        }
        latencies.sort((a, b) => a - b);
        let cadenceResult: SelftestResult["cadence"];
        if (cadence) {
          const tempoBpm = bpm();
          const ids = (looks ?? runtime.looks.list().map((l) => l.id)).filter((id) => {
            const l = runtime.looks.get(id);
            return l && runtime.stepsOf(l).length > 1;
          });
          const checks: CadenceCheck[] = [];
          for (const id of ids) checks.push(await measureLook(id, tempoBpm));
          cadenceResult = { bpm: tempoBpm, looks: checks };
        }
        return {
          total: all.length,
          passed: all.length - failed.length,
          failed,
          exclusivity,
          latencyMs: { p50: Math.round((latencies[Math.floor(latencies.length / 2)] ?? 0) * 100) / 100, max: Math.round((latencies.at(-1) ?? 0) * 100) / 100 },
          ...(cadenceResult ? { cadence: cadenceResult } : {}),
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
