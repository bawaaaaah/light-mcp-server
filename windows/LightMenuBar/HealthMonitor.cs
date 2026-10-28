using System;
using System.IO;
using System.Net;
using System.Text;
using System.Web.Script.Serialization; // not available maybe; parse manually

namespace LightMCPMenuBar {
    public class HealthMonitor {
        public string Status { get; private set; }
        public Action OnChange;
        private System.Threading.Timer _timer;
        private readonly System.Threading.SynchronizationContext _ctx;

        public HealthMonitor() {
            _ctx = System.Threading.SynchronizationContext.Current;
        }

        public void Start(double intervalSeconds = 3) {
            Stop();
            _timer = new System.Threading.Timer(_ => { Check(); }, null, 0, (int)(intervalSeconds * 1000));
        }

        public void Stop() { if (_timer != null) { _timer.Dispose(); _timer = null; } }

        public void Reset() { Update(null); Check(null); }

        public void Check(Action<string> completion = null) {
            var url = "http://" + AppSettings.LocalHost + ":" + AppSettings.Port + "/health";
            try {
                var req = (HttpWebRequest)WebRequest.Create(url);
                req.Timeout = 2000;
                req.BeginGetResponse(ar => {
                    string status = null;
                    try {
                        using (var resp = (HttpWebResponse)req.EndGetResponse(ar)) {
                            if (resp.StatusCode == HttpStatusCode.OK) {
                                using (var s = new StreamReader(resp.GetResponseStream(), Encoding.UTF8)) {
                                    var text = s.ReadToEnd();
                                    status = ExtractStatus(text) ?? "UNKNOWN";
                                }
                            }
                        }
                    } catch { status = null; }
                    Post(() => { Update(status); if (completion != null) completion(status); });
                }, null);
            } catch {
                Post(() => { Update(null); if (completion != null) completion(null); });
            }
        }

        private static string ExtractStatus(string json) {
            if (string.IsNullOrEmpty(json)) return null;
            // find "status":"..."
            var key = "\"status\"";
            int idx = json.IndexOf(key, StringComparison.OrdinalIgnoreCase);
            if (idx < 0) return null;
            int colon = json.IndexOf(':', idx);
            if (colon < 0) return null;
            int i = colon + 1;
            while (i < json.Length && (json[i] == ' ' || json[i] == '\t')) i++;
            if (i < json.Length && json[i] == '"') {
                int end = json.IndexOf('"', i + 1);
                if (end > i) return json.Substring(i + 1, end - i - 1);
            }
            return null;
        }

        private void Update(string newStatus) {
            if (newStatus == Status) return;
            Status = newStatus;
            if (OnChange != null) OnChange();
        }

        private void Post(Action a) {
            if (_ctx != null) _ctx.Post(_ => a(), null);
            else a();
        }
    }
}