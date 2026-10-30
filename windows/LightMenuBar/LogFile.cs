using System;
using System.Globalization;
using System.IO;
using System.Security.AccessControl;
using System.Text;

namespace LightMCPMenuBar {
    /// <summary>
    /// data/prod.log, opened for appending only so the app, the server and the build can all write to it,
    /// even through several handles at once: with FileMode.Append alone, each handle keeps its own position
    /// and overwrites what the others appended.
    /// </summary>
    public sealed class LogFile : IDisposable {
        private static readonly Encoding Utf8 = new UTF8Encoding(false);
        private readonly FileStream _stream;
        private readonly object _gate = new object();

        private LogFile(FileStream stream) { _stream = stream; }

        public static LogFile Open() {
            if (!AppSettings.RepoFound) return null;
            try {
                Directory.CreateDirectory(AppSettings.DataPath);
                var stream = new FileStream(AppSettings.LogPath, FileMode.Append, FileSystemRights.AppendData, FileShare.ReadWrite | FileShare.Delete, 4096, FileOptions.None);
                return new LogFile(stream);
            } catch { return null; }
        }

        public static void AppendLine(string line) {
            using (var log = Open()) {
                if (log != null) log.WriteLine(line);
            }
        }

        /// <summary>A line of the app's own, timestamped.</summary>
        public void WriteLine(string line) {
            WriteRawLine(DateTime.UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", CultureInfo.InvariantCulture) + " " + line);
        }

        /// <summary>A line of the server's or the build's output, as it came. Safe from any thread.</summary>
        public void WriteRawLine(string line) {
            var bytes = Utf8.GetBytes(line + "\r\n");
            lock (_gate) {
                try {
                    _stream.Write(bytes, 0, bytes.Length);
                    _stream.Flush();
                } catch { }
            }
        }

        public void Dispose() {
            lock (_gate) {
                try { _stream.Dispose(); } catch { }
            }
        }
    }
}
