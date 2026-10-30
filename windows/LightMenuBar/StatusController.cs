using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Windows.Forms;
using Microsoft.Win32;

namespace LightMCPMenuBar {
    /// <summary>
    /// The notification area icon and its menu. The menu is rebuilt each time it opens; the icon follows
    /// every state change.
    /// </summary>
    public sealed class StatusController : IDisposable {
        private readonly ServerSupervisor _supervisor = new ServerSupervisor();
        private readonly HealthMonitor _health = new HealthMonitor();
        private readonly Builder _builder = new Builder();
        private readonly ContextMenuStrip _menu;
        private readonly NotifyIcon _tray;
        private bool _disposed;

        private enum Display { Building, Stopping, Starting, Running, Restarting, Crashed, External, Stopped }

        /// <summary>Created on the UI thread, once its SynchronizationContext is installed.</summary>
        public StatusController() {
            _menu = new ContextMenuStrip { ShowItemToolTips = true };
            // WinForms cancels opening a menu that has no items yet, which this one has not the first time.
            _menu.Opening += (s, e) => {
                RebuildMenu();
                e.Cancel = false;
            };
            _tray = new NotifyIcon { ContextMenuStrip = _menu };
            _tray.DoubleClick += (s, e) => OpenDashboard();

            _supervisor.OnChange = () => {
                if (!_supervisor.IsRunning) _health.Reset();
                else _health.Check();
                RefreshIcon();
            };
            _health.OnChange = RefreshIcon;
            _builder.OnChange = RefreshIcon;
            SystemEvents.UserPreferenceChanged += ThemeChanged;
            RefreshIcon();
            _tray.Visible = true;
        }

        public void Launch() {
            _health.Start();
            _health.Check(status => {
                if (AppSettings.StartServerOnLaunch && status == null && !_supervisor.IsRunning) StartServer();
            });
        }

        /// <summary>The server is a child of this app: quitting the app, or the Windows session, stops it.</summary>
        public void Shutdown() {
            if (_disposed) return;
            _health.Stop();
            _supervisor.StopAndWait();
            Dispose();
        }

        public void Dispose() {
            if (_disposed) return;
            _disposed = true;
            SystemEvents.UserPreferenceChanged -= ThemeChanged;
            _health.Stop();
            // Hidden before the process ends, or its icon would stay in the notification area until hovered.
            _tray.Visible = false;
            _tray.Dispose();
            _menu.Dispose();
        }

        // State

        private Display CurrentDisplay() {
            if (_builder.IsBuilding && !_supervisor.IsRunning) return Display.Building;
            switch (_supervisor.CurrentPhase) {
                case ServerSupervisor.Phase.Stopping: return Display.Stopping;
                case ServerSupervisor.Phase.Running: return _health.Status != null ? Display.Running : Display.Starting;
                case ServerSupervisor.Phase.WaitingToRestart: return Display.Restarting;
                case ServerSupervisor.Phase.Crashed: return Display.Crashed;
                default: return _health.Status != null ? Display.External : Display.Stopped;
            }
        }

        private string StatusText() {
            string text;
            switch (CurrentDisplay()) {
                case Display.Building: text = "Compilation…"; break;
                case Display.Stopping: text = "Arrêt…"; break;
                case Display.Starting: text = "Démarrage…"; break;
                case Display.Running: text = "En marche · " + Label(_health.Status); break;
                case Display.Restarting: text = "Planté, redémarrage…"; break;
                case Display.Crashed: text = "Planté, voir les journaux"; break;
                case Display.External: text = "En marche (lancé à part) · " + Label(_health.Status); break;
                default: text = AppSettings.RepoFound ? "Arrêté" : "Dépôt introuvable"; break;
            }
            if (_builder.IsBuilding && _supervisor.IsRunning) text += " · compilation…";
            return text;
        }

        /// <summary>
        /// The /health aggregate in words; DEGRADED usually means Art-Net discovery could not bind port 6454
        /// (QLC+ running on the same PC).
        /// </summary>
        private static string Label(string status) {
            switch (status) {
                case "HEALTHY": return "OK";
                case "DEGRADED": return "dégradé";
                case "ERROR": return "en erreur";
                default: return status;
            }
        }

        private void RefreshIcon() {
            if (_disposed) return;
            Icon icon;
            switch (CurrentDisplay()) {
                case Display.Running: icon = _health.Status == "HEALTHY" ? TrayIcons.Normal : SystemIcons.Warning; break;
                case Display.Crashed:
                case Display.Restarting: icon = SystemIcons.Warning; break;
                case Display.Building:
                case Display.Starting:
                case Display.Stopping: icon = TrayIcons.Busy; break;
                case Display.Stopped: icon = TrayIcons.Dimmed; break;
                default: icon = TrayIcons.Normal; break;
            }
            _tray.Icon = icon;
            // NotifyIcon.Text refuses more than 63 characters.
            var tip = "Light MCP · " + StatusText();
            _tray.Text = tip.Length <= 63 ? tip : tip.Substring(0, 62) + "…";
        }

        private void ThemeChanged(object sender, UserPreferenceChangedEventArgs e) {
            if (e.Category != UserPreferenceCategory.General) return;
            TrayIcons.Reload();
            RefreshIcon();
        }

        // Menu

        private void RebuildMenu() {
            var old = new ToolStripItem[_menu.Items.Count];
            _menu.Items.CopyTo(old, 0);
            _menu.Items.Clear();
            foreach (var item in old) item.Dispose();

            AddInfo("Light MCP · " + StatusText());
            if (_supervisor.Pid.HasValue) AddInfo("pid " + _supervisor.Pid.Value + " · port " + AppSettings.Port);
            _menu.Items.Add(new ToolStripSeparator());

            var busy = _builder.IsBuilding || _supervisor.CurrentPhase == ServerSupervisor.Phase.Stopping;
            var external = CurrentDisplay() == Display.External;
            if (_supervisor.IsRunning || _supervisor.CurrentPhase == ServerSupervisor.Phase.WaitingToRestart) {
                Add("Arrêter", StopServer, _supervisor.CurrentPhase != ServerSupervisor.Phase.Stopping);
            } else {
                Add("Démarrer", StartServer, !busy && !external);
            }
            Add("Redémarrer", RestartServer, !busy && !external);
            Add("Recompiler et redémarrer", RebuildAndRestart, !busy && !external);
            _menu.Items.Add(new ToolStripSeparator());

            Add("Ouvrir l'interface", OpenDashboard, true);
            var publicUrl = AppSettings.PublicUrl();
            if (publicUrl != null) Add("Ouvrir l'adresse publique", OpenPublicUrl, true).ToolTipText = publicUrl.GetLeftPart(UriPartial.Query);
            Add("Afficher les journaux", ShowLogs, true);
            _menu.Items.Add(new ToolStripSeparator());

            Add("Lancer le serveur à l'ouverture de l'app", ToggleAutoStart, true).Checked = AppSettings.StartServerOnLaunch;
            Add("Ouvrir à la connexion", ToggleOpenAtLogin, true).Checked = IsOpenAtLogin();
            _menu.Items.Add(new ToolStripSeparator());

            Add("Quitter (arrête le serveur)", Quit, true);
        }

        private ToolStripMenuItem Add(string title, Action action, bool enabled) {
            var item = new ToolStripMenuItem(title) { Enabled = enabled };
            item.Click += (s, e) => action();
            _menu.Items.Add(item);
            return item;
        }

        private void AddInfo(string title) {
            _menu.Items.Add(new ToolStripMenuItem(title) { Enabled = false });
        }

        // Actions

        private void StartServer() {
            if (!CheckRepo()) return;
            if (File.Exists(AppSettings.EntryPointPath)) _supervisor.Start();
            else RebuildAndRestart();
        }

        private void StopServer() { _supervisor.Stop(); }

        private void RestartServer() { _supervisor.Restart(); }

        /// <summary>The running server keeps serving during the build and is only restarted once it succeeds.</summary>
        private void RebuildAndRestart() {
            if (!CheckRepo()) return;
            _builder.Build((success, tail) => {
                if (success) _supervisor.Restart();
                else ShowAlert("La compilation a échoué", tail);
            });
        }

        private bool CheckRepo() {
            if (AppSettings.RepoFound) return true;
            var repo = AppSettings.RepoPath;
            ShowAlert("Dépôt introuvable",
                "Light MCP ne trouve pas le dépôt du serveur" + (repo.Length > 0 ? " (" + repo + ")" : "") + ".\n\n" +
                "Réinstaller l'app avec windows\\build-app.ps1 depuis le dépôt, ou indiquer son chemin puis rouvrir l'app :\n\n" +
                "reg add HKCU\\Software\\LightMCPMenuBar /v repoPath /t REG_SZ /d \"C:\\chemin\\light-mcp-server\" /f");
            return false;
        }

        private void OpenDashboard() { Open(AppSettings.DashboardUrl); }

        private void OpenPublicUrl() {
            var url = AppSettings.PublicUrl();
            if (url != null) Open(url);
        }

        private static void Open(Uri url) {
            try {
                Process.Start(url.AbsoluteUri);
            } catch (Exception ex) {
                ShowAlert("Impossible d'ouvrir le navigateur", ex.Message);
            }
        }

        /// <summary>Follows data/prod.log as it grows, in a PowerShell window (Notepad would not refresh).</summary>
        private void ShowLogs() {
            var path = AppSettings.LogPath;
            if (!File.Exists(path)) {
                ShowAlert("Pas encore de journaux", path + " n'existe pas encore : il apparaît au premier démarrage du serveur.");
                return;
            }
            try {
                Process.Start("powershell.exe", "-NoProfile -NoExit -Command \"$Host.UI.RawUI.WindowTitle = 'Light MCP - journaux'; Get-Content -LiteralPath '" + path.Replace("'", "''") + "' -Tail 200 -Wait -Encoding UTF8\"");
            } catch {
                try {
                    Process.Start("notepad.exe", "\"" + path + "\"");
                } catch (Exception ex) {
                    ShowAlert("Impossible d'ouvrir les journaux", ex.Message);
                }
            }
        }

        private void ToggleAutoStart() { AppSettings.StartServerOnLaunch = !AppSettings.StartServerOnLaunch; }

        private const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
        private const string RunValueName = "LightMCPMenuBar";

        private static bool IsOpenAtLogin() {
            try {
                using (var key = Registry.CurrentUser.OpenSubKey(RunKey)) {
                    return key != null && key.GetValue(RunValueName) != null;
                }
            } catch { return false; }
        }

        private void ToggleOpenAtLogin() {
            try {
                var enabled = IsOpenAtLogin();
                using (var key = Registry.CurrentUser.CreateSubKey(RunKey)) {
                    if (enabled) key.DeleteValue(RunValueName, false);
                    else key.SetValue(RunValueName, "\"" + Application.ExecutablePath + "\"", RegistryValueKind.String);
                }
            } catch (Exception ex) {
                ShowAlert("Impossible de changer « Ouvrir à la connexion »", ex.Message);
            }
        }

        /// <summary>Once the menu has closed: shutting down disposes it.</summary>
        private void Quit() {
            _menu.BeginInvoke(new Action(() => {
                Shutdown();
                Application.Exit();
            }));
        }

        /// <summary>A warning above every window: the app has none of its own to put it on.</summary>
        private static void ShowAlert(string title, string text) {
            using (var owner = new Form { TopMost = true }) {
                MessageBox.Show(owner, text, title, MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
        }
    }
}
