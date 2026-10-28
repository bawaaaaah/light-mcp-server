using System;
using System.Drawing;
using System.Drawing.Drawing2D;

namespace LightMCPMenuBar {
    /// <summary>
    /// Tray icons drawn to mirror the macOS menu bar app's projector symbol
    /// (SF Symbol "light.overhead.right"), including a dimmed variant for the
    /// stopped state.
    /// </summary>
    public static class TrayIcons {
        public static readonly Icon Normal;
        public static readonly Icon Dimmed;

        private static readonly Bitmap _normalBmp;
        private static readonly Bitmap _dimmedBmp;

        static TrayIcons() {
            _normalBmp = Draw(false);
            _dimmedBmp = Draw(true);
            Normal = Icon.FromHandle(_normalBmp.GetHicon());
            Dimmed = Icon.FromHandle(_dimmedBmp.GetHicon());
        }

        private static Bitmap Draw(bool dimmed) {
            var bmp = new Bitmap(32, 32, System.Drawing.Imaging.PixelFormat.Format32bppArgb);
            using (var g = Graphics.FromImage(bmp)) {
                g.SmoothingMode = SmoothingMode.AntiAlias;
                g.Clear(Color.Transparent);
                int a = dimmed ? 90 : 255;
                // projector body
                using (var b = new SolidBrush(Color.FromArgb(a, 70, 70, 75))) {
                    g.FillRectangle(b, 6, 10, 20, 12);
                    g.FillRectangle(b, 14, 22, 4, 6);
                    g.FillRectangle(b, 10, 28, 12, 2);
                }
                // lens
                using (var b = new SolidBrush(Color.FromArgb(a, 220, 220, 225))) {
                    g.FillEllipse(b, 10, 12, 8, 8);
                }
                using (var p = new Pen(Color.FromArgb(a, 40, 40, 45))) {
                    g.DrawEllipse(p, 10, 12, 8, 8);
                }
                // light beam
                using (var b = new SolidBrush(Color.FromArgb(dimmed ? 40 : 140, 255, 225, 120))) {
                    g.FillEllipse(b, 12, 4, 4, 4);
                }
            }
            return bmp;
        }
    }
}