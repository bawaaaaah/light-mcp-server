using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace LightMCPMenuBar {
    /// <summary>
    /// Owns the `node dist/cli/main.js serve` child: starts it, stops it and restarts it when it dies on
    /// its own. Windows has no SIGTERM, so the server runs with LIGHT_STOP_ON_STDIN_CLOSE: closing its
    /// stdin makes it save and exit, and it is killed if it is still there 5 s later. Its stdin also
    /// closes when the app dies, so unlike on macOS the server never outlives the app and is never taken
    /// back over (its output goes through the app anyway). The app never touches a process it did not start.
    /// </summary>
    public sealed class ServerSupervisor {
        public enum Phase {
            Stopped,
            Running,
            Stopping,
            /// <summary>Died on its own; a restart is scheduled.</summary>
            WaitingToRestart,
            /// <summary>Died too often in a row; left stopped until the user acts.</summary>
            Crashed
        }

        public Phase CurrentPhase { get; private set; }
        public int? Pid { get { return _process == null ? (int?)null : _pid; } }
        public Action OnChange;
        public bool IsRunning { get { return CurrentPhase == Phase.Running || CurrentPhase == Phase.Stopping; } }

        private Process _process;
        private int _pid;
        private LogFile _log;
        private bool _wantRunning;
        private readonly List<DateTime> _crashTimes = new List<DateTime>();
        private System.Windows.Forms.Timer _restartTimer;
        private System.Windows.Forms.Timer _killTimer;
        private readonly List<Action> _stopCompletions = new List<Action>();
        private readonly SynchronizationContext _ui;

        private static readonly int[] RestartDelays = { 1, 2, 5, 10 };
        private const int CrashLimit = 5;
        private static readonly TimeSpan CrashWindow = TimeSpan.FromSeconds(60);
        private const int StopTimeoutMs = 5000;

        /// <summary>Created on the UI thread: every state change happens there.</summary>
        public ServerSupervisor() { _ui = SynchronizationContext.Current; }

        public void Start() {
            if (_process != null) return;
            CancelTimer(ref _restartTimer);
            _wantRunning = true;

            var log = LogFile.Open();
            if (log != null) log.WriteLine("[menubar] starting node " + AppSettings.EntryPoint + " serve on port " + AppSettings.Port);

            var psi = new ProcessStartInfo {
                FileName = AppSettings.NodePath,
                Arguments = "\"" + AppSettings.EntryPoint + "\" serve",
                WorkingDirectory = AppSettings.RepoPath,
                UseShellExecute = false,
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                StandardOutputEncoding = Encoding.UTF8,
                StandardErrorEncoding = Encoding.UTF8,
                CreateNoWindow = true
            };
            AppSettings.ApplyChildEnvironment(psi.EnvironmentVariables);
            psi.EnvironmentVariables["LIGHT_STOP_ON_STDIN_CLOSE"] = "1";

            var process = new Process { StartInfo = psi, EnableRaisingEvents = true };
            // Done once the process has exited and both its outputs have ended, so its last lines reach the
            // log before it closes (Exited alone can come first).
            int pending = 3;
            Action oneDone = () => { if (Interlocked.Decrement(ref pending) == 0) Post(() => ProcessExited(process)); };
            DataReceivedEventHandler collect = (s, e) => {
                if (e.Data == null) oneDone();
                else if (log != null) log.WriteRawLine(e.Data);
            };
            process.OutputDataReceived += collect;
            process.ErrorDataReceived += collect;
            process.Exited += (s, e) => oneDone();

            try {
                process.Start();
            } catch (Exception ex) {
                if (log != null) {
                    log.WriteLine("[menubar] could not start node: " + ex.Message);
                    log.Dispose();
                }
                process.Dispose();
                RecordCrash();
                return;
            }
            process.BeginOutputReadLine();
            process.BeginErrorReadLine();

            _process = process;
            _pid = process.Id;
            _log = log;
            SetPhase(Phase.Running);
        }

        public void Stop(Action completion = null) {
            _wantRunning = false;
            CancelTimer(ref _restartTimer);

            var process = _process;
            if (process == null) {
                if (CurrentPhase != Phase.Stopped) SetPhase(Phase.Stopped);
                if (completion != null) completion();
                return;
            }
            if (completion != null) _stopCompletions.Add(completion);
            if (CurrentPhase == Phase.Stopping) return;
            SetPhase(Phase.Stopping);

            Log("[menubar] stopping server (pid " + _pid + ")");
            try { process.StandardInput.Close(); } catch { }
            _killTimer = After(StopTimeoutMs, () => {
                _killTimer = null;
                if (process != _process) return;
                Log("[menubar] server still running 5 s after its stdin closed, killing it");
                try { process.Kill(); } catch { }
            });
        }

        public void Restart() { Stop(() => Start()); }

        /// <summary>Stops the server and waits until it is gone, for the app's own exit.</summary>
        public void StopAndWait() {
            var process = _process;
            Stop();
            if (process == null) return;
            var deadline = DateTime.UtcNow.AddMilliseconds(StopTimeoutMs + 2000);
            while (_process == process && DateTime.UtcNow < deadline) {
                Application.DoEvents();
                Thread.Sleep(50);
            }
            if (_process == process) {
                try { process.Kill(); } catch { }
            }
        }

        private void ProcessExited(Process process) {
            if (process != _process) return;
            int status = -1;
            try { status = process.ExitCode; } catch { }
            CancelTimer(ref _killTimer);
            _process = null;
            process.Dispose();

            var completions = new List<Action>(_stopCompletions);
            _stopCompletions.Clear();

            Log(_wantRunning ? "[menubar] server exited with status " + status + " unexpectedly" : "[menubar] server stopped");
            if (_log != null) {
                _log.Dispose();
                _log = null;
            }
            if (_wantRunning) RecordCrash();
            else SetPhase(Phase.Stopped);
            foreach (var completion in completions) completion();
        }

        private void RecordCrash() {
            var now = DateTime.UtcNow;
            _crashTimes.RemoveAll(t => now - t >= CrashWindow);
            _crashTimes.Add(now);
            if (_crashTimes.Count >= CrashLimit) {
                Log("[menubar] " + _crashTimes.Count + " crashes in " + (int)CrashWindow.TotalSeconds + " s, giving up");
                _wantRunning = false;
                _crashTimes.Clear();
                SetPhase(Phase.Crashed);
                return;
            }
            var delay = RestartDelays[Math.Min(_crashTimes.Count - 1, RestartDelays.Length - 1)];
            _restartTimer = After(delay * 1000, () => {
                _restartTimer = null;
                if (_wantRunning) Start();
            });
            SetPhase(Phase.WaitingToRestart);
        }

        private void SetPhase(Phase phase) {
            CurrentPhase = phase;
            if (OnChange != null) OnChange();
        }

        private void Log(string line) {
            if (_log != null) _log.WriteLine(line);
            else LogFile.AppendLine(line);
        }

        private void Post(Action action) {
            if (_ui != null) _ui.Post(_ => action(), null);
            else action();
        }

        /// <summary>Runs the action once, on the UI thread, after the delay.</summary>
        private static System.Windows.Forms.Timer After(int ms, Action action) {
            var timer = new System.Windows.Forms.Timer { Interval = ms };
            timer.Tick += (s, e) => {
                timer.Stop();
                timer.Dispose();
                action();
            };
            timer.Start();
            return timer;
        }

        private static void CancelTimer(ref System.Windows.Forms.Timer timer) {
            if (timer == null) return;
            timer.Stop();
            timer.Dispose();
            timer = null;
        }
    }
}
