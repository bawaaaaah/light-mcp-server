using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using Microsoft.Win32;
using System.Windows.Forms;

namespace LightMCPMenuBar {
    public class StatusController {
        private readonly Form _hidden;
        private readonly NotifyIcon _tray;
        private readonly ContextMenuStrip _menu;
        private readonly ServerSupervisor _supervisor;
        private readonly HealthMonitor _health;
        private readonly Builder _builder;

        private enum Display { Building, Stopping, Starting, Running, Restarting, Crashed, External, Stopped }

        public StatusController(Form hidden) {
            _hidden = hidden;
            _supervisor = new ServerSupervisor();
            _health = new HealthMonitor();
            _builder = new Builder();

            _menu = new ContextMenuStrip();
            _menu.Opening += (s, e) => RebuildMenu();

            _tray = new NotifyIcon {
                Icon = SystemIcons.Application,
                Visible = true,
                ContextMenuStrip = _menu,
                Text = "Light MCP"
            };
            _tray.DoubleClick += (s, e) => OpenDashboard();

            _supervisor.OnChange = () => {
                if (!_supervisor.IsRunning) _health.Reset(); else _health.Check();
                RefreshIcon();
            };
            _health.OnChange = () => RefreshIcon();
            _builder.OnChange = () => RefreshIcon();
            RefreshIcon();
        }

        public void Launch() {
            _supervisor.AdoptLeftoverServer();
            _health.Start();
            _health.Check(status => {
                if (AppSettings.StartServerOnLaunch && status == null && !_supervisor.IsRunning) {
                    StartServer();
                }
            });
        }

        public void Shutdown() { _supervisor.StopAndWait(); }

        private Display CurrentDisplay() {
            if (_builder.IsBuilding && !_supervisor.IsRunning) return Display.Building;
            switch (_supervisor.CurrentPhase) {
                case ServerSupervisor.Phase.Stopping: return Display.Stopping;
                case ServerSupervisor.Phase.Running:
                    return _health.Status != null ? Display.Running : Display.Starting;
                case ServerSupervisor.Phase.WaitingToRestart: return Display.Restarting;
                case ServerSupervisor.Phase.Crashed: return Display.Crashed;
                case ServerSupervisor.Phase.Stopped:
                    return _health.Status != null ? Display.External : Display.Stopped;
            }
            return Display.Stopped;
        }

        private string StatusText() {
            string text;
            switch (CurrentDisplay()) {
                case Display.Building: text = "Compilation..."; break;
                case Display.Stopping: text = "Arret..."; break;
                case Display.Starting: text = "Demarrage..."; break;
                case Display.Running: text = "En marche . " + Label(_health.Status); break;
                case Display.Restarting: text = "Plante, redemarrage..."; break;
                case Display.Crashed: text = "Plante, voir les journaux"; break;
                case Display.External: text = "En marche (lance a part) . " + Label(_health.Status); break;
                default: text = "Arrete"; break;
            }
            if (_builder.IsBuilding && _supervisor.IsRunning) text += " . compilation...";
            return text;
        }

        private static string Label(string status) {
            switch (status) {
                case "HEALTHY": return "OK";
                case "DEGRADED": return "degrade";
                case "ERROR": return "en erreur";
                default: return status ?? "";
            }
        }

        private bool IsExternal { get { var d = CurrentDisplay(); return d == Display.External; } }

        private void RefreshIcon() {
            try {
                if (!_hidden.IsHandleCreated) { try { var h = _hidden.Handle; } catch { } }
                _hidden.Invoke(new Action(() => {
                    var d = CurrentDisplay();
                    Icon icon;
                    switch (d) {
                        case Display.Running:
                            icon = (_health.Status != "HEALTHY") ? SystemIcons.Warning : SystemIcons.Application;
                            break;
                        case Display.Crashed:
                        case Display.Restarting:
                            icon = SystemIcons.Warning;
                            break;
                        case Display.Building:
                        case Display.Starting:
                        case Display.Stopping:
                            icon = SystemIcons.Information;
                            break;
                        case Display.Stopped:
                            icon = SystemIcons.Application;
                            break;
                        default:
                            icon = SystemIcons.Application;
                            break;
                    }
                    _tray.Icon = icon;
                    _tray.Text = "Light MCP . " + StatusText();
                }));
            } catch { }
        }

        private void RebuildMenu() {
            _menu.Items.Clear();
            var header = new ToolStripMenuItem("Light MCP . " + StatusText()) { Enabled = false };
            _menu.Items.Add(header);
            if (_supervisor.Pid.HasValue) {
                var detail = new ToolStripMenuItem("pid " + _supervisor.Pid.Value + " . port " + AppSettings.Port) { Enabled = false };
                _menu.Items.Add(detail);
            }
            _menu.Items.Add(new ToolStripSeparator());

            bool busy = _builder.IsBuilding || _supervisor.CurrentPhase == ServerSupervisor.Phase.Stopping;
            if (_supervisor.IsRunning || _supervisor.CurrentPhase == ServerSupervisor.Phase.WaitingToRestart) {
                _menu.Items.Add(MakeItem("Arreter", (s, e) => StopServer(), _supervisor.CurrentPhase != ServerSupervisor.Phase.Stopping));
            } else {
                _menu.Items.Add(MakeItem("Demarrer", (s, e) => StartServer(), !busy && !IsExternal));
            }
            _menu.Items.Add(MakeItem("Redemarrer", (s, e) => RestartServer(), !busy && !IsExternal));
            _menu.Items.Add(MakeItem("Recompiler et redemarrer", (s, e) => RebuildAndRestart(), !busy && !IsExternal));
            _menu.Items.Add(new ToolStripSeparator());

            _menu.Items.Add(MakeItem("Ouvrir l'interface", (s, e) => OpenDashboard(), true));
            var pub = AppSettings.PublicUrl();
            if (pub != null) {
                var pi = MakeItem("Ouvrir l'adresse publique", (s, e) => OpenPublicUrl(), true);
                pi.ToolTipText = pub.AbsoluteUri.Split('#')[0];
                _menu.Items.Add(pi);
            }
            _menu.Items.Add(MakeItem("Afficher les journaux", (s, e) => ShowLogs(), true));
            _menu.Items.Add(new ToolStripSeparator());

            var autoStart = new ToolStripMenuItem("Lancer le serveur a l'ouverture de l'app") {
                CheckOnClick = false,
                Checked = AppSettings.StartServerOnLaunch
            };
            autoStart.Click += (s, e) => { AppSettings.StartServerOnLaunch = !AppSettings.StartServerOnLaunch; };
            _menu.Items.Add(autoStart);

            var login = new ToolStripMenuItem("Ouvrir a la connexion") { Checked = IsOpenAtLogin() };
            login.Click += (s, e) => ToggleOpenAtLogin();
            _menu.Items.Add(login);
            _menu.Items.Add(new ToolStripSeparator());

            var quit = MakeItem("Quitter (arrete le serveur)", (s, e) => Quit(), true);
            quit.ShortcutKeys = Keys.Control | Keys.Q;
            _menu.Items.Add(quit);
        }

        private ToolStripMenuItem MakeItem(string title, EventHandler handler, bool enabled) {
            var item = new ToolStripMenuItem(title);
            item.Enabled = enabled;
            if (enabled) item.Click += handler;
            return item;
        }

        private void StartServer() {
            if (System.IO.File.Exists(AppSettings.EntryPointPath)) {
                _supervisor.Start();
            } else {
                RebuildAndRestart();
            }
        }
        private void StopServer() { _supervisor.Stop(); }
        private void RestartServer() { _supervisor.Restart(); }
        private void RebuildAndRestart() {
            _builder.Build((success, tail) => {
                if (success) _supervisor.Restart();
                else ShowAlert("La compilation a echoue", tail);
            });
        }
        private void OpenDashboard() {
            try { Process.Start(AppSettings.DashboardUrl.AbsoluteUri); } catch { }
        }
        private void OpenPublicUrl() {
            var url = AppSettings.PublicUrl();
            if (url != null) try { Process.Start(url.AbsoluteUri); } catch { }
        }
        private void ShowLogs() {
            try { Process.Start("notepad.exe", "\"" + AppSettings.LogPath + "\""); } catch {
                try { Process.Start(AppSettings.LogPath); } catch { }
            }
        }

        private const string RunKey = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";
        private const string RunValueName = "LightMCPMenuBar";
        private bool IsOpenAtLogin() {
            try {
                using (var k = Registry.CurrentUser.OpenSubKey(RunKey)) {
                    return k != null && k.GetValue(RunValueName) != null;
                }
            } catch { return false; }
        }
        private void ToggleOpenAtLogin() {
            try {
                using (var k = Registry.CurrentUser.OpenSubKey(RunKey, true)) {
                    if (k == null) return;
                    if (IsOpenAtLogin()) k.DeleteValue(RunValueName, false);
                    else k.SetValue(RunValueName, "\"" + Application.ExecutablePath + "\"", RegistryValueKind.String);
                }
            } catch (Exception ex) {
                ShowAlert("Impossible de changer \"Ouvrir a la connexion\"", ex.Message);
            }
        }

        private void Quit() {
            _tray.Visible = false;
            _supervisor.StopAndWait();
            Application.Exit();
        }

        private void ShowAlert(string title, string text) {
            MessageBox.Show(text, title, MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
    }
}