/**
 * A QR code for a link (docs/specs/ui-dashboards.md, « Connexion »): a tablet's camera opens the
 * interface signed in, without typing the address and the PIN. Drawn as SVG modules from
 * qrcode-generator, error correction M; dark on a white quiet zone, as phone cameras expect.
 */
import { useMemo } from "react";
import qrcode from "qrcode-generator";

export function QrCode({ text, label, size = 220 }: { text: string; label: string; size?: number }) {
  const { n, path } = useMemo(() => {
    const qr = qrcode(0, "M");
    qr.addData(text);
    qr.make();
    const count = qr.getModuleCount();
    let d = "";
    for (let r = 0; r < count; r++) for (let c = 0; c < count; c++) if (qr.isDark(r, c)) d += `M${c + 4} ${r + 4}h1v1h-1z`;
    return { n: count + 8, path: d };
  }, [text]);
  return (
    <svg className="qr-code" viewBox={`0 0 ${n} ${n}`} width={size} height={size} role="img" aria-label={label} shapeRendering="crispEdges">
      <rect width={n} height={n} fill="#ffffff" />
      <path d={path} fill="#000000" />
    </svg>
  );
}
