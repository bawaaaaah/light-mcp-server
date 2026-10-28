using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading;

namespace LightMCPMenuBar {
    public class Builder {
        public bool IsBuilding { get; private set; }
        public Action OnChange;
        private readonly System.Threading.SynchronizationContext _ctx;

        public Builder() { _ctx = System.Threading.SynchronizationContext.Current; }

        public void Build(Action<bool, string> completion) {
            if (IsBuilding) return;
            IsBuilding = true;
            if (OnChange != null) OnChange();

            var psi = new ProcessStartInfo {
                FileName = "cmd.exe",
                Arguments = "/c npm run build",
                WorkingDirectory = AppSettings.RepoPath,
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true
            };
            // env
            foreach (var kv in AppSettings.ChildEnvironment()) {
                try { psi.EnvironmentVariables[kv.Key] = kv.Value; } catch { }
            }

            var proc = new Process { StartInfo = psi, EnableRaisingEvents = true };
            var output = new StringBuilder();
            var lockObj = new object();
            proc.OutputDataReceived += (s, e) => { if (e.Data != null) { lock (lockObj) output.AppendLine(e.Data); } };
            proc.ErrorDataReceived += (s, e) => { if (e.Data != null) { lock (lockObj) output.AppendLine(e.Data); } };

            using (var log = LogFile.Open()) {
                if (log != null) log.WriteLine("[menubar] npm run build");
                proc.Start();
                proc.BeginOutputReadLine();
                proc.BeginErrorReadLine();

                proc.Exited += (s, e) => {
                    try { proc.WaitForExit(); } catch { }
                    bool success = proc.ExitCode == 0;
                    string tail;
                    lock (lockObj) {
                        var lines = output.ToString().Split(new[] { "\r\n", "\n" }, StringSplitOptions.None);
                        int start = Math.Max(0, lines.Length - 20);
                        tail = string.Join("\n", lines, start, lines.Length - start);
                    }
                    try { using (var l = LogFile.Open()) { if (l != null) l.WriteLine("[menubar] build " + (success ? "succeeded" : "failed (" + proc.ExitCode + ")")); } } catch { }
                    Post(() => {
                        IsBuilding = false;
                        if (OnChange != null) OnChange();
                        if (completion != null) completion(success, tail);
                    });
                };
            }
        }

        private void Post(Action a) {
            if (_ctx != null) _ctx.Post(_ => a(), null);
            else a();
        }
    }
}