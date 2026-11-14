import { useSyncExternalStore } from "react";
import { lightState, type MotionLockSummary } from "../api";
import { control } from "../ws";

/** « Figer les lyres » as every control shows it (T26): the lock's levels and the installed moving heads. */
export interface MotionLockView {
  lock: MotionLockSummary;
  movingHeads: { total: number; frozen: number };
}

type StatePayload = { motionLock?: MotionLockSummary; movingHeads?: { total: number; frozen: number } };

const FREE: MotionLockSummary = { level: "off", heads: {}, effective: "off" };
let current: MotionLockView | null = null;
const listeners = new Set<() => void>();
let started = false;

function take(state: StatePayload): void {
  const next: MotionLockView = { lock: state.motionLock ?? FREE, movingHeads: state.movingHeads ?? { total: 0, frozen: 0 } };
  // the state topic speaks every second something changes elsewhere (standby, sources): keep the same object when the lock did not move
  if (current && JSON.stringify(current) === JSON.stringify(next)) return;
  current = next;
  for (const listener of listeners) listener();
}

/** One subscription for the whole page: the top bar, the widgets, the pads and the menus read the same view. */
function start(): void {
  if (started) return;
  started = true;
  control.subscribe("light:state", (data) => take(data as StatePayload));
  const read = () => void lightState().then(take, () => undefined);
  // the topic only speaks on a change: read once now, and again whenever the link comes back
  control.onStatus((up) => up && read());
  read();
}

function subscribe(listener: () => void): () => void {
  start();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The lock and the moving heads, null until the server answered once. */
export function useMotionLock(): MotionLockView | null {
  return useSyncExternalStore(subscribe, () => current);
}
