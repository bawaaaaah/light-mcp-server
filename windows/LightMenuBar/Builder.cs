using System;
using System.Diagnostics;
using System.Text;
using System.Threading;

namespace LightMCPMenuBar {
    /// <summary>
    /// Runs `npm run build` in the checkout. Output goes to data/prod.log and is kept so a failure can
    /// show its last lines.
    /// </summary>
    public sealed class Builder {
        public bool IsBuilding { get; private set; }
        public Action OnChange;
        private readonly SynchronizationContext _ui;

        /// <summary>Created on the UI thread: the completion runs there.</summary>
        public Builder() { _ui = SynchronizationContext.Current; }

        public void Build(Action<bool, string> completion) {
            if (IsBuilding) return;

            var psi = new ProcessStartInfo {
                FileName = Environment.GetEnvironmentVariable("ComSpec") ?? "cmd.exe",
                Arguments = "/d /c npm run build",
                WorkingDirectory = AppSettings.RepoPath,
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                StandardOutputEncoding = Encoding.UTF8,
                StandardErrorEncoding = Encoding.UTF8,
                CreateNoWindow = true
            };
            AppSettings.ApplyChildEnvironment(psi.EnvironmentVariables);

            var log = LogFile.Open();
            if (log != null) log.WriteLine("[menubar] npm run build");
            var output = new StringBuilder();
            var process = new Process { StartInfo = psi, EnableRaisingEvents = true };
            // Done once npm has exited and both its outputs have ended (Exited alone can come first).
            int pending = 3;
            Action oneDone = () => {
                if (Interlocked.Decrement(ref pending) != 0) return;
                int status = -1;
                try { status = process.ExitCode; } catch { }
                process.Dispose();
                var success = status == 0;
                string tail;
                lock (output) tail = Tail(output.ToString(), 20);
                if (log != null) {
                    log.WriteLine("[menubar] build " + (success ? "succeeded" : "failed (" + status + ")"));
                    log.Dispose();
                }
                Post(() => {
                    IsBuilding = false;
                    if (OnChange != null) OnChange();
                    if (completion != null) completion(success, tail);
                });
            };
            DataReceivedEventHandler collect = (s, e) => {
                if (e.Data == null) {
                    oneDone();
                    return;
                }
                lock (output) output.AppendLine(e.Data);
                if (log != null) log.WriteRawLine(e.Data);
            };
            process.OutputDataReceived += collect;
            process.ErrorDataReceived += collect;
            process.Exited += (s, e) => oneDone();

            try {
                process.Start();
            } catch (Exception ex) {
                if (log != null) {
                    log.WriteLine("[menubar] could not run npm: " + ex.Message);
                    log.Dispose();
                }
                process.Dispose();
                if (completion != null) completion(false, "npm n'a pas pu être lancé : " + ex.Message);
                return;
            }
            process.BeginOutputReadLine();
            process.BeginErrorReadLine();
            IsBuilding = true;
            if (OnChange != null) OnChange();
        }

        private static string Tail(string text, int lines) {
            var all = text.TrimEnd().Split(new[] { "\r\n", "\n" }, StringSplitOptions.None);
            var start = Math.Max(0, all.Length - lines);
            return string.Join("\n", all, start, all.Length - start);
        }

        private void Post(Action action) {
            if (_ui != null) _ui.Post(_ => action(), null);
            else action();
        }
    }
}
