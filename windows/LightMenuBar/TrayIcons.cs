using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Windows.Forms;
using Microsoft.Win32;

namespace LightMCPMenuBar {
    /// <summary>
    /// The notification area icons, drawn after the macOS app's projector (SF Symbol
    /// "light.overhead.right"): normal, dimmed when the server is stopped, and circling arrows while it
    /// starts, stops or builds. They are drawn at the small icon size, light on a dark taskbar and dark
    /// on a light one; Reload() redraws them when the theme changes.
    /// </summary>
    public static class TrayIcons {
        public static Icon Normal { get; private set; }
        public static Icon Dimmed { get; private set; }
        public static Icon Busy { get; private set; }

        static TrayIcons() { Reload(); }

        public static void Reload() {
            var old = new[] { Normal, Dimmed, Busy };
            var ink = DarkTaskbar() ? Color.FromArgb(240, 240, 240) : Color.FromArgb(32, 32, 36);
            var size = SystemInformation.SmallIconSize.Width;
            Normal = Render(size, g => Projector(g, ink, false));
            Dimmed = Render(size, g => Projector(g, ink, true));
            Busy = Render(size, g => Arrows(g, ink));
            foreach (var icon in old) {
                if (icon != null) icon.Dispose();
            }
        }

        private static readonly PointF[] Lens = { new PointF(24, 11), new PointF(29, 6), new PointF(29, 25), new PointF(24, 20) };

        /// <summary>A projector on its stand, its lens lit in warm white, or all greyed out when dimmed.</summary>
        private static void Projector(Graphics g, Color ink, bool dimmed) {
            using (var body = new SolidBrush(Color.FromArgb(dimmed ? 120 : 255, ink)))
            using (var lens = new SolidBrush(dimmed ? Color.FromArgb(120, ink) : Color.FromArgb(255, 200, 60))) {
                g.FillRectangle(body, 4, 9, 20, 13); // housing
                g.FillRectangle(body, 13, 22, 4, 5); // yoke
                g.FillRectangle(body, 8, 27, 14, 3); // base
                g.FillPolygon(lens, Lens);
            }
        }

        /// <summary>Two arrows chasing each other.</summary>
        private static void Arrows(Graphics g, Color ink) {
            using (var pen = new Pen(ink, 3.5f)) {
                pen.CustomEndCap = new AdjustableArrowCap(2.2f, 2.2f);
                g.DrawArc(pen, 6, 6, 20, 20, 200, 130);
                g.DrawArc(pen, 6, 6, 20, 20, 20, 130);
            }
        }

        /// <summary>Draws on a 32-unit canvas scaled to the icon size.</summary>
        private static Icon Render(int size, Action<Graphics> draw) {
            using (var bitmap = new Bitmap(size, size, PixelFormat.Format32bppArgb)) {
                using (var g = Graphics.FromImage(bitmap)) {
                    g.SmoothingMode = SmoothingMode.AntiAlias;
                    g.Clear(Color.Transparent);
                    g.ScaleTransform(size / 32f, size / 32f);
                    draw(g);
                }
                var handle = bitmap.GetHicon();
                try {
                    using (var borrowed = Icon.FromHandle(handle)) return (Icon)borrowed.Clone();
                } finally {
                    DestroyIcon(handle);
                }
            }
        }

        /// <summary>Windows 10 1903+ says whether the taskbar is light; before that, it is dark.</summary>
        private static bool DarkTaskbar() {
            try {
                using (var key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize")) {
                    var light = key == null ? null : key.GetValue("SystemUsesLightTheme");
                    return !(light is int && (int)light != 0);
                }
            } catch { return true; }
        }

        [DllImport("user32.dll")]
        private static extern bool DestroyIcon(IntPtr handle);
    }
}
