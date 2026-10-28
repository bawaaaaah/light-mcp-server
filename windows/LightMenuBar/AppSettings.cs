using System;
using System.IO;
using System.Text;
using Microsoft.Win32;
using System.Web.Script.Serialization; // may not exist; avoid. Use simple JSON? We'll parse minimal with regex? Better use System.Text.Json not in .NET 4.8. Use manual.

namespace LightMCPMenuBar {
    public static class AppSettings {
        private const string RegPath = "Software\\LightMCPMenuBar";
        private static readonly string AppDir = Path.GetDirectoryName(System.Reflection.Assembly.GetExecutingAssembly().Location) ?? "";
        private static readonly string DefaultsFile = Path.Combine(AppDir, "appsettings.json");

        private static string RegString(string key) {
            try {
                using (var k = Registry.CurrentUser.OpenSubKey(RegPath)) {
                    if (k == null) return null;
                    return k.GetValue(key) as string;
                }
            } catch { return null; }
        }
        private static int? RegInt(string key) {
            try {
                using (var k = Registry.CurrentUser.OpenSubKey(RegPath)) {
                    if (k == null) return null;
                    var v = k.GetValue(key);
                    if (v is int) return (int)v;
                    int p;
                    if (v != null && int.TryParse(v.ToString(), out p)) return p;
                    return null;
                }
            } catch { return null; }
        }

        private static string FileValue(string key) {
            try {
                if (!File.Exists(DefaultsFile)) return null;
                var text = File.ReadAllText(DefaultsFile);
                // very small parser: "key": "value" or "key": 123
                var needle = "\"" + key + "\"";
                int idx = text.IndexOf(needle, StringComparison.OrdinalIgnoreCase);
                if (idx < 0) return null;
                int colon = text.IndexOf(':', idx);
                if (colon < 0) return null;
                // skip ws
                int i = colon + 1;
                while (i < text.Length && (text[i] == ' ' || text[i] == '\t' || text[i] == '\n' || text[i] == '\r')) i++;
                if (i >= text.Length) return null;
                if (text[i] == '"') {
                    int end = text.IndexOf('"', i + 1);
                    if (end < 0) return null;
                    return text.Substring(i + 1, end - i - 1);
                } else {
                    int end = i;
                    while (end < text.Length && (char.IsDigit(text[end]) || text[end] == '-')) end++;
                    return text.Substring(i, end - i);
                }
            } catch { return null; }
        }

        public static string RepoPath {
            get {
                var v = RegString("repoPath") ?? FileValue("repoPath");
                if (string.IsNullOrWhiteSpace(v)) v = Path.GetFullPath(Path.Combine(AppDir, "..", ".."));
                return v;
            }
        }
        public static System.Uri RepoUrl { get { return new System.Uri(RepoPath + (RepoPath.EndsWith("\\") ? "" : "\\")); } }

        public static string NodePath {
            get {
                var v = RegString("nodePath") ?? FileValue("nodePath");
                if (string.IsNullOrWhiteSpace(v)) v = "node";
                return v;
            }
        }

        public static int Port {
            get {
                if (RegInt("port").HasValue) return RegInt("port").Value;
                var cfg = ServerConfig();
                if (cfg != null && cfg.ContainsKey("port")) {
                    int p; if (int.TryParse(cfg["port"], out p) && p > 0 && p <= 65535) return p;
                }
                var fv = FileValue("port");
                if (!string.IsNullOrWhiteSpace(fv)) { int p; if (int.TryParse(fv, out p) && p > 0) return p; }
                return 8790;
            }
        }

        public static string LocalHost {
            get {
                var cfg = ServerConfig();
                string host = null;
                if (cfg != null && cfg.ContainsKey("host")) host = cfg["host"];
                if (string.IsNullOrWhiteSpace(host)) return "127.0.0.1";
                host = host.Trim();
                if (host == "0.0.0.0" || host == "::") return "127.0.0.1";
                return host.Contains(":") ? "[" + host + "]" : host;
            }
        }

        public static bool StartServerOnLaunch {
            get {
                try {
                    using (var k = Registry.CurrentUser.OpenSubKey(RegPath)) {
                        if (k == null) return true;
                        var v = k.GetValue("startServerOnLaunch");
                        if (v is int) return ((int)v) != 0;
                        if (v != null) { bool b; if (bool.TryParse(v.ToString(), out b)) return b; }
                    }
                } catch { }
                return true;
            }
            set {
                try {
                    using (var k = Registry.CurrentUser.CreateSubKey(RegPath)) {
                        k.SetValue("startServerOnLaunch", value ? 1 : 0, RegistryValueKind.DWord);
                    }
                } catch { }
            }
        }

        public static string EntryPoint { get { return "dist/cli/main.js"; } }
        public static string EntryPointPath { get { return Path.Combine(RepoPath, "dist", "cli", "main.js"); } }
        public static string DataPath { get { return Path.Combine(RepoPath, "data"); } }
        public static string LogPath { get { return Path.Combine(DataPath, "prod.log"); } }
        public static string PidPath { get { return Path.Combine(DataPath, "menubar.pid"); } }

        public static System.Uri DashboardUrl {
            get {
                var url = "http://" + LocalHost + ":" + Port + "/";
                return WithToken(new System.Uri(url));
            }
        }

        private static System.Collections.Generic.Dictionary<string,string> ServerConfig() {
            try {
                var path = Path.Combine(DataPath, "machine", "config.json");
                if (!File.Exists(path)) return null;
                var text = File.ReadAllText(path);
                // find "server" object
                int idx = text.IndexOf("\"server\"", StringComparison.OrdinalIgnoreCase);
                if (idx < 0) return null;
                int brace = text.IndexOf('{', idx);
                if (brace < 0) return null;
                // match braces
                int depth = 0; int end = -1;
                for (int i = brace; i < text.Length; i++) {
                    if (text[i] == '{') depth++;
                    else if (text[i] == '}') { depth--; if (depth == 0) { end = i; break; } }
                }
                if (end < 0) return null;
                var obj = text.Substring(brace + 1, end - brace - 1);
                var dict = new System.Collections.Generic.Dictionary<string,string>(StringComparer.OrdinalIgnoreCase);
                // parse "key": value (string or number)
                // simple regex-ish scan
                int pos = 0;
                while (pos < obj.Length) {
                    int q = obj.IndexOf('"', pos);
                    if (q < 0) break;
                    int q2 = obj.IndexOf('"', q + 1);
                    if (q2 < 0) break;
                    var key = obj.Substring(q + 1, q2 - q - 1);
                    int col = obj.IndexOf(':', q2);
                    if (col < 0) break;
                    int vstart = col + 1;
                    while (vstart < obj.Length && (obj[vstart] == ' ' || obj[vstart] == '\t' || obj[vstart] == '\n' || obj[vstart] == '\r')) vstart++;
                    string val;
                    if (vstart < obj.Length && obj[vstart] == '"') {
                        int ve = obj.IndexOf('"', vstart + 1);
                        if (ve < 0) break;
                        val = obj.Substring(vstart + 1, ve - vstart - 1);
                        pos = ve + 1;
                    } else {
                        int ve = vstart;
                        while (ve < obj.Length && (char.IsDigit(obj[ve]) || obj[ve] == '-' || obj[ve] == '.')) ve++;
                        val = obj.Substring(vstart, ve - vstart);
                        pos = ve;
                    }
                    if (!dict.ContainsKey(key)) dict[key] = val;
                }
                return dict;
            } catch { return null; }
        }

        public static string AuthToken {
            get {
                var cfg = ServerConfig();
                if (cfg != null && cfg.ContainsKey("authToken")) return cfg["authToken"];
                return null;
            }
        }

        public static System.Uri WithToken(System.Uri url) {
            var token = AuthToken;
            if (string.IsNullOrWhiteSpace(token)) return url;
            var ub = new System.UriBuilder(url);
            ub.Fragment = "token=" + Uri.EscapeDataString(token);
            return ub.Uri;
        }

        public static System.Uri PublicUrl() {
            var cfg = ServerConfig();
            if (cfg == null || !cfg.ContainsKey("publicUrl")) return null;
            var value = cfg["publicUrl"];
            if (string.IsNullOrWhiteSpace(value)) return null;
            System.Uri url;
            if (!System.Uri.TryCreate(value, System.UriKind.Absolute, out url)) return null;
            if (url.Host == "localhost" || url.Host == "127.0.0.1") return null;
            return WithToken(url);
        }

        public static System.Collections.Generic.Dictionary<string,string> ChildEnvironment() {
            var env = new System.Collections.Generic.Dictionary<string,string>(StringComparer.OrdinalIgnoreCase);
            foreach (System.Collections.DictionaryEntry de in Environment.GetEnvironmentVariables()) {
                env[de.Key.ToString()] = de.Value == null ? "" : de.Value.ToString();
            }
            var nodeDir = Path.GetDirectoryName(NodePath);
            var inherited = env.ContainsKey("PATH") ? env["PATH"] : "/usr/bin:/bin";
            env["PATH"] = nodeDir + ";" + nodeDir + ";" + inherited;
            // port override only if registry port set
            if (RegInt("port").HasValue) env["PORT"] = Port.ToString();
            else env.Remove("PORT");
            return env;
        }

        public static void SetRegistry(string key, object value) {
            try {
                using (var k = Registry.CurrentUser.CreateSubKey(RegPath)) {
                    if (value == null) k.DeleteValue(key, false);
                    else if (value is int) k.SetValue(key, value, RegistryValueKind.DWord);
                    else k.SetValue(key, value.ToString(), RegistryValueKind.String);
                }
            } catch { }
        }
    }
}