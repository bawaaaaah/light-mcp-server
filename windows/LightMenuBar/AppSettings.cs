using System;
using System.Collections.Generic;
using System.Collections.Specialized;
using System.Globalization;
using System.IO;
using System.Text;
using System.Web.Script.Serialization;
using Microsoft.Win32;

namespace LightMCPMenuBar {
    /// <summary>
    /// Where the server lives and how to run it. repoPath, nodePath and port can be set under
    /// HKCU\Software\LightMCPMenuBar; otherwise they come from appsettings.json, which build-app.ps1
    /// writes next to the installed exe, and the checkout is looked for around the exe.
    /// </summary>
    public static class AppSettings {
        private const string RegPath = @"Software\LightMCPMenuBar";
        private static readonly string AppDir = AppDomain.CurrentDomain.BaseDirectory;

        public static string RepoPath {
            get {
                var path = RegString("repoPath") ?? FileString("repoPath") ?? FindCheckout(AppDir);
                return path == null ? "" : Environment.ExpandEnvironmentVariables(path.Trim().Trim('"'));
            }
        }

        /// <summary>Whether RepoPath holds a checkout (the app cannot run anything otherwise).</summary>
        public static bool RepoFound {
            get {
                var repo = RepoPath;
                return repo.Length > 0 && File.Exists(Path.Combine(repo, "package.json"));
            }
        }

        public static string NodePath {
            get {
                var path = RegString("nodePath") ?? FileString("nodePath");
                return path == null ? "node" : Environment.ExpandEnvironmentVariables(path.Trim().Trim('"'));
            }
        }

        /// <summary>
        /// A registry port overrides server.port of data/machine/config.json (the server's own setting,
        /// see src/core/env.ts), which overrides 8790.
        /// </summary>
        public static int Port {
            get {
                var port = PortOverride;
                if (port.HasValue) return port.Value;
                var configured = ServerValue("port");
                if (configured is int && (int)configured > 0 && (int)configured <= 65535) return (int)configured;
                return 8790;
            }
        }

        private static int? PortOverride {
            get {
                var value = RegValue("port");
                int port;
                if (value is int) port = (int)value;
                else if (!(value is string) || !int.TryParse((string)value, out port)) return null;
                return port > 0 && port <= 65535 ? port : (int?)null;
            }
        }

        /// <summary>Where this PC reaches the server: server.host when it names one interface, else loopback.</summary>
        public static string LocalHost {
            get {
                var host = ServerValue("host") as string;
                host = host == null ? "" : host.Trim();
                if (host.Length == 0 || host == "0.0.0.0" || host == "::") return "127.0.0.1";
                return host.Contains(":") ? "[" + host + "]" : host;
            }
        }

        public static bool StartServerOnLaunch {
            get {
                var value = RegValue("startServerOnLaunch");
                if (value is int) return (int)value != 0;
                bool enabled;
                return value is string && bool.TryParse((string)value, out enabled) ? enabled : true;
            }
            set {
                try {
                    using (var key = Registry.CurrentUser.CreateSubKey(RegPath)) {
                        key.SetValue("startServerOnLaunch", value ? 1 : 0, RegistryValueKind.DWord);
                    }
                } catch { }
            }
        }

        /// <summary>`node EntryPoint serve`, the same as `npm start`.</summary>
        public const string EntryPoint = "dist/cli/main.js";
        public static string EntryPointPath { get { return Path.Combine(RepoPath, "dist", "cli", "main.js"); } }
        /// <summary>The checkout's data/ folder, as src/core/paths.ts resolves it for a source checkout.</summary>
        public static string DataPath { get { return Path.Combine(RepoPath, "data"); } }
        public static string LogPath { get { return Path.Combine(DataPath, "prod.log"); } }

        /// <summary>The web UI, logged in with the master token (`#token=`, read by web/src/api.ts).</summary>
        public static Uri DashboardUrl {
            get { return WithToken(new Uri("http://" + LocalHost + ":" + Port.ToString(CultureInfo.InvariantCulture) + "/")); }
        }

        /// <summary>server.publicUrl from data/machine/config.json, unless it is just the localhost default.</summary>
        public static Uri PublicUrl() {
            var value = ServerValue("publicUrl") as string;
            Uri url;
            if (string.IsNullOrWhiteSpace(value) || !Uri.TryCreate(value, UriKind.Absolute, out url)) return null;
            if (url.Host == "localhost" || url.Host == "127.0.0.1") return null;
            return WithToken(url);
        }

        /// <summary>The URL with `#token=authToken`; the fragment never reaches the server or its logs.</summary>
        private static Uri WithToken(Uri url) {
            var token = ServerValue("authToken") as string;
            if (string.IsNullOrEmpty(token)) return url;
            return new UriBuilder(url) { Fragment = "token=" + Uri.EscapeDataString(token) }.Uri;
        }

        /// <summary>
        /// The environment for node and npm: the app's own, with node's directory first on PATH. Without a
        /// port override the server reads server.port itself, and an inherited PORT would beat it.
        /// </summary>
        public static void ApplyChildEnvironment(StringDictionary env) {
            string nodeDir = null;
            try { if (Path.IsPathRooted(NodePath)) nodeDir = Path.GetDirectoryName(NodePath); } catch { }
            if (!string.IsNullOrEmpty(nodeDir)) env["PATH"] = nodeDir + ";" + env["PATH"];
            var port = PortOverride;
            if (port.HasValue) env["PORT"] = port.Value.ToString(CultureInfo.InvariantCulture);
            else env.Remove("PORT");
        }

        /// <summary>A JSON document as dictionaries, arrays and numbers, or null when it does not parse.</summary>
        public static object ParseJson(string text) {
            try {
                return new JavaScriptSerializer { MaxJsonLength = int.MaxValue }.DeserializeObject(text);
            } catch { return null; }
        }

        // The `server` section of data/machine/config.json, read again only when the file changes.
        private static readonly object CacheGate = new object();
        private static string _cachedPath;
        private static DateTime _cachedWrite;
        private static long _cachedLength;
        private static IDictionary<string, object> _cachedServer;

        private static object ServerValue(string name) {
            var server = ServerConfig();
            object value;
            return server != null && server.TryGetValue(name, out value) ? value : null;
        }

        private static IDictionary<string, object> ServerConfig() {
            var path = Path.Combine(DataPath, "machine", "config.json");
            lock (CacheGate) {
                try {
                    var info = new FileInfo(path);
                    if (!info.Exists) return null;
                    if (path == _cachedPath && info.LastWriteTimeUtc == _cachedWrite && info.Length == _cachedLength) return _cachedServer;
                    var root = ReadJson(path) as IDictionary<string, object>;
                    if (root == null) return null;
                    object server;
                    root.TryGetValue("server", out server);
                    _cachedPath = path;
                    _cachedWrite = info.LastWriteTimeUtc;
                    _cachedLength = info.Length;
                    _cachedServer = server as IDictionary<string, object>;
                    return _cachedServer;
                } catch { return null; }
            }
        }

        /// <summary>
        /// Reads with every share mode, so the server can still replace the file (write then rename) while
        /// the app has it open.
        /// </summary>
        private static object ReadJson(string path) {
            try {
                using (var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
                using (var reader = new StreamReader(stream, Encoding.UTF8)) {
                    return ParseJson(reader.ReadToEnd());
                }
            } catch { return null; }
        }

        private static string FileString(string name) {
            var settings = ReadJson(Path.Combine(AppDir, "appsettings.json")) as IDictionary<string, object>;
            object value;
            var text = settings != null && settings.TryGetValue(name, out value) ? value as string : null;
            return string.IsNullOrWhiteSpace(text) ? null : text;
        }

        /// <summary>The checkout around the exe (windows\build\LightMCP\ when it is run from there), if any.</summary>
        private static string FindCheckout(string dir) {
            try {
                for (var d = new DirectoryInfo(dir); d != null; d = d.Parent) {
                    if (File.Exists(Path.Combine(d.FullName, "package.json")) && Directory.Exists(Path.Combine(d.FullName, "windows", "LightMenuBar"))) return d.FullName;
                }
            } catch { }
            return null;
        }

        private static object RegValue(string name) {
            try {
                using (var key = Registry.CurrentUser.OpenSubKey(RegPath)) {
                    return key == null ? null : key.GetValue(name);
                }
            } catch { return null; }
        }

        private static string RegString(string name) {
            var text = RegValue(name) as string;
            return string.IsNullOrWhiteSpace(text) ? null : text;
        }
    }
}
