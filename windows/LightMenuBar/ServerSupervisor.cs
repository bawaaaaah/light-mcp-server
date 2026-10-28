using System;
using System.Diagnostics;
using System.IO;
using System.Threading;

namespace LightMCPMenuBar {
    public class ServerSupervisor {
        public enum Phase { Stopped, Running, Stopping, WaitingToRestart, Crashed }
        private Phase _currentPhase = Phase.Stopped;
        public Phase CurrentPhase { get { return _currentPhase; } private set { _currentPhase = value; } }
        public int? Pid { get; private set; }
        public Action OnChange;
        public bool IsRunning { get { return CurrentPhase == Phase.Running || CurrentPhase == Phase.Stopping; } }

        private Process _process;
        private int? _adoptedPid;
        private System.Threading.Timer _adoptedWatch;
        private bool _wantRunning = false;
        private readonly System.Collections.Generic.List<DateTime> _crashTimes = new System.Collections.Generic.List<DateTime>();
        private System.Threading.Timer _restartWork;
        private readonly System.Collections.Generic.List<Action> _stopCompletions = new System.Collections.Generic.List<Action>();
        private readonly System.Threading.SynchronizationContext _ctx;

        private static readonly int[] RestartDelays = new int[] { 1, 2, 5, 10 };
        private const int CrashLimit = 5;
        private static readonly TimeSpan CrashWindow = TimeSpan.FromSeconds(60);

        public ServerSupervisor() { _ctx = System.Threading.SynchronizationContext.Current; }

        public void Start() {
            if (_process != null || _adoptedPid.HasValue) return;
            if (_restartWork != null) { _restartWork.Dispose(); _restartWork = null; }
            _wantRunning = true;

            using (var log = LogFile.Open()) {
                if (log != null) log.WriteLine("[menubar] starting node " + AppSettings.EntryPoint + " serve on port " + AppSettings.Port);
            }

            var psi = new ProcessStartInfo {
                FileName = AppSettings.NodePath,
                Arguments = "\"" + AppSettings.EntryPoint + "\" serve",
                WorkingDirectory = AppSettings.RepoPath,
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true
            };
            foreach (var kv in AppSettings.ChildEnvironment()) {
                try { psi.EnvironmentVariables[kv.Key] = kv.Value; } catch { }
            }

            var proc = new Process { StartInfo = psi, EnableRaisingEvents = true };
            var logHandle = LogFile.Open();
            if (logHandle != null) {
                proc.OutputDataReceived += (s, e) => { if (e.Data != null) logHandle.WriteLine(e.Data); };
                proc.ErrorDataReceived += (s, e) => { if (e.Data != null) logHandle.WriteLine(e.Data); };
            }

            try {
                proc.Start();
                proc.BeginOutputReadLine();
                proc.BeginErrorReadLine();
            } catch (Exception ex) {
                try { if (logHandle != null) logHandle.WriteLine("[menubar] could not start node: " + ex.Message); } catch { }
                try { if (logHandle != null) logHandle.Dispose(); } catch { }
                RecordCrash();
                return;
            }
            // child holds its own descriptor; close ours
            try { if (logHandle != null) logHandle.Dispose(); } catch { }

            proc.Exited += (s, e) => {
                int status = 0;
                try { status = proc.ExitCode; } catch { }
                Post(() => ProcessExited(status));
            };

            _process = proc;
            Pid = proc.Id;
            try { File.WriteAllText(AppSettings.PidPath, proc.Id.ToString()); } catch { }
            SetPhase(Phase.Running);
        }

        public void AdoptLeftoverServer() {
            if (_process != null || _adoptedPid.HasValue) return;
            try {
                if (!File.Exists(AppSettings.PidPath)) return;
                var text = File.ReadAllText(AppSettings.PidPath).Trim();
                int leftover;
                if (!int.TryParse(text, out leftover)) { try { File.Delete(AppSettings.PidPath); } catch { } return; }
                Process p;
                try { p = Process.GetProcessById(leftover); } catch { try { File.Delete(AppSettings.PidPath); } catch { } return; }
                // best-effort command line check
                bool ok = true;
                try {
                    if (!p.ProcessName.ToLowerInvariant().Contains("node")) ok = false;
                } catch { ok = false; }
                if (!ok) { try { File.Delete(AppSettings.PidPath); } catch { } return; }

                _adoptedPid = leftover;
                Pid = leftover;
                _wantRunning = true;
                _adoptedWatch = new System.Threading.Timer(_ => {
                    bool alive = true;
                    try { Process.GetProcessById(leftover); } catch { alive = false; }
                    if (!alive) Post(() => ProcessExited(-1));
                }, null, 1000, 1000);
                SetPhase(Phase.Running);
            } catch { try { File.Delete(AppSettings.PidPath); } catch { } }
        }

        public void Stop(Action completion = null) {
            _wantRunning = false;
            if (_restartWork != null) { _restartWork.Dispose(); _restartWork = null; }

            if (!Pid.HasValue) {
                if (CurrentPhase != Phase.Stopped) SetPhase(Phase.Stopped);
                if (completion != null) completion();
                return;
            }
            if (completion != null) _stopCompletions.Add(completion);
            if (CurrentPhase == Phase.Stopping) return;
            SetPhase(Phase.Stopping);

            int target = Pid.Value;
            LogFile.AppendLine("[menubar] stopping server (pid " + target + ")");
            try { Process.GetProcessById(target).Kill(); } catch { }
            // wait up to 5s then ensure killed
            var t = new System.Threading.Timer(_ => {
                try {
                    var p = Process.GetProcessById(target);
                    try { p.Kill(); } catch { }
                } catch { }
            }, null, 5000, Timeout.Infinite);
        }

        public void Restart() { Stop(() => Start()); }

        public void StopAndWait(int timeoutMs = 6000) {
            if (!Pid.HasValue) return;
            Stop();
            var target = Pid.Value; // note: Pid cleared on exit
            var deadline = DateTime.Now.AddMilliseconds(timeoutMs);
            while (true) {
                bool alive = true;
                try { Process.GetProcessById(target); } catch { alive = false; }
                if (!alive || DateTime.Now >= deadline) break;
                System.Windows.Forms.Application.DoEvents();
                Thread.Sleep(100);
            }
        }

        private void ProcessExited(int status) {
            _process = null;
            _adoptedPid = null;
            if (_adoptedWatch != null) { _adoptedWatch.Dispose(); _adoptedWatch = null; }
            Pid = null;
            try { File.Delete(AppSettings.PidPath); } catch { }

            var completions = new System.Collections.Generic.List<Action>(_stopCompletions);
            _stopCompletions.Clear();

            if (_wantRunning) {
                LogFile.AppendLine("[menubar] server exited unexpectedly");
                RecordCrash();
            } else {
                LogFile.AppendLine("[menubar] server stopped");
                SetPhase(Phase.Stopped);
            }
            foreach (var c in completions) { try { c(); } catch { } }
        }

        private void RecordCrash() {
            var now = DateTime.Now;
            _crashTimes.RemoveAll(d => (now - d).TotalSeconds >= CrashWindow.TotalSeconds);
            _crashTimes.Add(now);
            if (_crashTimes.Count >= CrashLimit) {
                LogFile.AppendLine("[menubar] " + _crashTimes.Count + " crashes in " + (int)CrashWindow.TotalSeconds + " s, giving up");
                _wantRunning = false;
                _crashTimes.Clear();
                SetPhase(Phase.Crashed);
                return;
            }
            int idx = Math.Min(_crashTimes.Count - 1, RestartDelays.Length - 1);
            int delay = RestartDelays[idx];
            SetPhase(Phase.WaitingToRestart);
            _restartWork = new System.Threading.Timer(_ => {
                Post(() => { if (_wantRunning) Start(); });
            }, null, delay * 1000, Timeout.Infinite);
        }

        private void SetPhase(Phase newPhase) {
            CurrentPhase = newPhase;
            if (OnChange != null) OnChange();
        }

        private void Post(Action a) {
            if (_ctx != null) _ctx.Post(_ => a(), null);
            else a();
        }
    }
}