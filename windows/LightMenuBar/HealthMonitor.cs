using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Text;
using System.Threading;

namespace LightMCPMenuBar {
    /// <summary>Polls the server's anonymous `GET /health`, which answers `{"status":"HEALTHY"|"DEGRADED"|"ERROR"}`.</summary>
    public sealed class HealthMonitor {
        /// <summary>The last aggregate status, or null when nothing answered on the port.</summary>
        public string Status { get; private set; }
        public Action OnChange;

        private const int TimeoutMs = 2000;
        private System.Windows.Forms.Timer _timer;
        private readonly SynchronizationContext _ui;

        /// <summary>Created on the UI thread: status changes happen there.</summary>
        public HealthMonitor() { _ui = SynchronizationContext.Current; }

        public void Start(int intervalMs = 3000) {
            Stop();
            _timer = new System.Windows.Forms.Timer { Interval = intervalMs };
            _timer.Tick += (s, e) => Check();
            _timer.Start();
            Check();
        }

        public void Stop() {
            if (_timer == null) return;
            _timer.Stop();
            _timer.Dispose();
            _timer = null;
        }

        /// <summary>
        /// Forget the last answer, e.g. once our own process has exited, so a stale HEALTHY does not read
        /// as an external server for the next few seconds.
        /// </summary>
        public void Reset() {
            Update(null);
            Check();
        }

        public void Check(Action<string> completion = null) {
            HttpWebRequest request;
            try {
                request = (HttpWebRequest)WebRequest.Create("http://" + AppSettings.LocalHost + ":" + AppSettings.Port + "/health");
                request.Proxy = null; // never through the system proxy, and no proxy auto-detection delay
                request.KeepAlive = false; // a pooled connection would outlive a restarted server
                request.ReadWriteTimeout = TimeoutMs;
                var pending = request.BeginGetResponse(result => {
                    string status = null;
                    try {
                        using (var response = (HttpWebResponse)request.EndGetResponse(result))
                        using (var reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8)) {
                            if (response.StatusCode == HttpStatusCode.OK) status = StatusOf(reader.ReadToEnd());
                        }
                    } catch { }
                    Post(() => {
                        Update(status);
                        if (completion != null) completion(status);
                    });
                }, null);
                // Timeout does not apply to BeginGetResponse: abort a request that hangs.
                ThreadPool.RegisterWaitForSingleObject(pending.AsyncWaitHandle, (state, timedOut) => {
                    if (timedOut) request.Abort();
                }, null, TimeoutMs, true);
            } catch {
                Post(() => {
                    Update(null);
                    if (completion != null) completion(null);
                });
            }
        }

        /// <summary>The `status` of a /health body, "UNKNOWN" without one, null when it is not JSON.</summary>
        private static string StatusOf(string body) {
            var json = AppSettings.ParseJson(body) as IDictionary<string, object>;
            if (json == null) return null;
            object status;
            return json.TryGetValue("status", out status) && status is string ? (string)status : "UNKNOWN";
        }

        private void Update(string status) {
            if (status == Status) return;
            Status = status;
            if (OnChange != null) OnChange();
        }

        private void Post(Action action) {
            if (_ui != null) _ui.Post(_ => action(), null);
            else action();
        }
    }
}
