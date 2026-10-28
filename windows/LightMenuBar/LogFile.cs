using System;
using System.IO;
using System.Text;

namespace LightMCPMenuBar {
    public class LogFile : IDisposable {
        private FileStream _stream;
        private StreamWriter _writer;
        private LogFile(FileStream fs) { _stream = fs; _writer = new StreamWriter(fs) { AutoFlush = true }; }

        public static LogFile Open() {
            try {
                Directory.CreateDirectory(AppSettings.DataPath);
                var fs = new FileStream(AppSettings.LogPath, FileMode.Append, FileAccess.Write, FileShare.ReadWrite);
                return new LogFile(fs);
            } catch { return null; }
        }

        public static void AppendLine(string line) {
            try {
                using (var lf = Open()) { if (lf != null) lf.WriteLine(line); }
            } catch { }
        }

        public void WriteLine(string line) {
            try {
                var stamp = DateTime.UtcNow.ToString("o");
                _writer.WriteLine(stamp + " " + line);
            } catch { }
        }

        public void Write(string text) { try { _writer.Write(text); } catch { } }
        public void Write(byte[] data) { try { _stream.Write(data, 0, data.Length); _stream.Flush(); } catch { } }

        public void Dispose() { try { _writer.Dispose(); _stream.Dispose(); } catch { } }
        public void Close() { Dispose(); }
    }
}