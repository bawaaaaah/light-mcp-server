/** What the light plugin publishes on every engine frame to the WebSocket hub (docs/architecture.md, live topics). */
import { throttleMerge } from "../../../core/throttle.js";
import { followPosition, type SongServices } from "../commands/song-commands.js";
import type { DmxEngine } from "../engine/dmx-engine.js";
import type { OutputRouter } from "../output/output-router.js";
import { motionEntries, motionKey } from "../show/motion-report.js";
import type { ShowRuntime } from "../show/runtime.js";

export interface LivePublicationDeps {
  engine: DmxEngine;
  router: OutputRouter;
  runtime: ShowRuntime;
  songs: SongServices;
  publish: (type: string, payload: unknown) => void;
}

/**
 * On every frame: the song follows its position, the frame goes out to the nodes, then the dashboards hear the
 * frame, the gliding faders, why the moving heads are where they are and the rules' clamps; and the nodes found.
 */
export function wireLivePublications({ engine, router, runtime, songs, publish }: LivePublicationDeps): void {
  const publishFrame = throttleMerge<number>(
    40, // ≤ 25 Hz to dashboards (docs/architecture.md, topic light:dmx)
    (xs) => xs[xs.length - 1]!,
    (now) => publish("frame", { now, buffers: engine.output.buffers }),
  );
  // smoothed faders on their way (docs/specs/groups-masters.md, « Lissage »): ghost bars on the Live;
  // one empty message once all have arrived, so they go away
  const publishGlide = throttleMerge<ReturnType<ShowRuntime["gliding"]>>(40, (xs) => xs[xs.length - 1]!, (g) => publish("glide", g));
  let wasGliding = false;
  let lastClampKey = "";
  // why each moving head is where it is (T25): on a change of layer, owner, lock, rest, glide start or end, never
  // every frame; a burst (a look launched on every head, then its glide ending) leaves at most one message per
  // 100 ms, built when it leaves (the state then, not the state that triggered it)
  const publishMotion = throttleMerge<null>(100, () => null, () => publish("motion", { heads: motionEntries(runtime) }));
  let lastMotionKey = "";
  engine.onFrame((buffers, now) => {
    followPosition(songs);
    router.sendFrame(buffers);
    publishFrame(now);
    const glide = runtime.gliding();
    const gliding = !!glide && (glide.gm !== undefined || Object.keys(glide.groups).length > 0 || Object.keys(glide.faders).length > 0);
    if (glide && (gliding || wasGliding)) publishGlide(glide);
    wasGliding = gliding;
    const motion = motionKey(runtime);
    if (motion !== lastMotionKey) {
      lastMotionKey = motion;
      publishMotion(null);
    }
    const clamps = runtime.lastClamps;
    const key = clamps.map((c) => `${c.fixture}/${c.channel}/${c.to}`).join("|");
    if (key !== lastClampKey) {
      lastClampKey = key;
      publish("rules", { clamps });
    }
  });
  router.onNodesChanged(() => publish("nodes", router.nodes()));
}
