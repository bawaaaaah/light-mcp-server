import { useEffect, useState } from "react";

/**
 * Full screen to play (the Live): no side bar, no top bar, only the dashboards (`body.kiosk`). Leaving the browser's
 * full screen leaves it too. A tablet left on the Live must not fall asleep mid-service: full screen keeps the screen
 * awake (Screen Wake Lock, where the browser allows it: HTTPS or localhost).
 */
export function useKiosk(): { kiosk: boolean; toggleKiosk: () => void } {
  const [kiosk, setKiosk] = useState(false);
  useEffect(() => {
    document.body.classList.toggle("kiosk", kiosk);
    const out = () => !document.fullscreenElement && setKiosk(false);
    document.addEventListener("fullscreenchange", out);
    return () => {
      document.removeEventListener("fullscreenchange", out);
      document.body.classList.remove("kiosk");
    };
  }, [kiosk]);
  useEffect(() => {
    if (!kiosk) return;
    type Sentinel = { release(): Promise<void> };
    const nav = navigator as Navigator & { wakeLock?: { request(type: "screen"): Promise<Sentinel> } };
    let lock: Sentinel | undefined;
    let stop = false;
    const take = () => {
      if (stop || document.visibilityState !== "visible" || !nav.wakeLock) return;
      void nav.wakeLock.request("screen").then(
        (l) => (stop ? void l.release() : (lock = l)),
        () => undefined,
      );
    };
    take();
    document.addEventListener("visibilitychange", take); // the browser drops the lock when the page hides: taken again on return
    return () => {
      stop = true;
      document.removeEventListener("visibilitychange", take);
      void lock?.release().catch(() => undefined);
    };
  }, [kiosk]);
  const toggleKiosk = () => {
    if (kiosk) {
      if (document.fullscreenElement) void document.exitFullscreen?.();
      setKiosk(false);
    } else {
      void document.documentElement.requestFullscreen?.().catch(() => undefined);
      setKiosk(true);
    }
  };
  return { kiosk, toggleKiosk };
}
