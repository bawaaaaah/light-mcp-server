// Adapted from wing-mcp-server (MIT, https://github.com/bawaaaaah/wing-mcp-server), macos/WingMenuBar.
import AppKit
import ServiceManagement

/// The menu bar icon and its menu. The menu is rebuilt each time it opens; the icon follows every
/// state change.
@MainActor
final class StatusController: NSObject, NSMenuDelegate {
  private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
  private let supervisor = ServerSupervisor()
  private let health = HealthMonitor()
  private let builder = Builder()

  override init() {
    super.init()
    let menu = NSMenu()
    menu.delegate = self
    statusItem.menu = menu

    supervisor.onChange = { [weak self] in
      guard let self else { return }
      if !self.supervisor.isRunning { self.health.reset() } else { self.health.check() }
      self.refreshIcon()
    }
    health.onChange = { [weak self] in self?.refreshIcon() }
    builder.onChange = { [weak self] in self?.refreshIcon() }
    refreshIcon()
  }

  func launch() {
    supervisor.adoptLeftoverServer()
    health.start()
    health.check { [weak self] status in
      guard let self, AppSettings.startServerOnLaunch, status == nil, !self.supervisor.isRunning else { return }
      self.startServer()
    }
  }

  func shutdown() {
    supervisor.stopAndWait()
  }

  // MARK: State

  private enum Display {
    case building, stopping, starting, running(String), restarting, crashed, external(String), stopped
  }

  private var display: Display {
    if builder.isBuilding && !supervisor.isRunning { return .building }
    switch supervisor.phase {
    case .stopping: return .stopping
    case .running: return health.status.map { .running($0) } ?? .starting
    case .waitingToRestart: return .restarting
    case .crashed: return .crashed
    case .stopped: return health.status.map { .external($0) } ?? .stopped
    }
  }

  private var statusText: String {
    var text: String
    switch display {
    case .building: text = "Compilation…"
    case .stopping: text = "Arrêt…"
    case .starting: text = "Démarrage…"
    case .running(let status): text = "En marche · \(Self.label(status))"
    case .restarting: text = "Planté, redémarrage…"
    case .crashed: text = "Planté, voir les journaux"
    case .external(let status): text = "En marche (lancé à part) · \(Self.label(status))"
    case .stopped: text = "Arrêté"
    }
    if builder.isBuilding, supervisor.isRunning { text += " · compilation…" }
    return text
  }

  /// The `/health` aggregate in words; DEGRADED usually means Art-Net discovery could not bind
  /// port 6454 (QLC+ running on the same Mac).
  private static func label(_ status: String) -> String {
    switch status {
    case "HEALTHY": return "OK"
    case "DEGRADED": return "dégradé"
    case "ERROR": return "en erreur"
    default: return status
    }
  }

  private var isExternal: Bool {
    if case .external = display { return true }
    return false
  }

  private func refreshIcon() {
    guard let button = statusItem.button else { return }
    let symbol: String
    var dimmed = false
    switch display {
    case .running(let status) where status != "HEALTHY": symbol = "exclamationmark.triangle"
    case .crashed, .restarting: symbol = "exclamationmark.triangle"
    case .running, .external: symbol = "light.overhead.right"
    case .building, .starting, .stopping: symbol = "arrow.triangle.2.circlepath"
    case .stopped:
      symbol = "light.overhead.right"
      dimmed = true
    }
    let image = NSImage(systemSymbolName: symbol, accessibilityDescription: "Serveur Light MCP")
    image?.isTemplate = true
    button.image = image
    button.appearsDisabled = dimmed
    button.toolTip = "Light MCP · \(statusText)"
  }

  // MARK: Menu

  func menuNeedsUpdate(_ menu: NSMenu) {
    menu.removeAllItems()

    let header = NSMenuItem(title: "Light MCP · \(statusText)", action: nil, keyEquivalent: "")
    header.isEnabled = false
    menu.addItem(header)
    if let pid = supervisor.pid {
      let detail = NSMenuItem(title: "pid \(pid) · port \(AppSettings.port)", action: nil, keyEquivalent: "")
      detail.isEnabled = false
      menu.addItem(detail)
    }
    menu.addItem(.separator())

    let busy = builder.isBuilding || supervisor.phase == .stopping
    if supervisor.isRunning || supervisor.phase == .waitingToRestart {
      menu.addItem(item("Arrêter", #selector(stopServer), enabled: supervisor.phase != .stopping))
    } else {
      menu.addItem(item("Démarrer", #selector(startServer), enabled: !busy && !isExternal))
    }
    menu.addItem(item("Redémarrer", #selector(restartServer), enabled: !busy && !isExternal))
    menu.addItem(item("Recompiler et redémarrer", #selector(rebuildAndRestart), enabled: !busy && !isExternal))
    menu.addItem(.separator())

    menu.addItem(item("Ouvrir l'interface", #selector(openDashboard), enabled: true))
    if let url = AppSettings.publicURL() {
      let publicItem = item("Ouvrir l'adresse publique", #selector(openPublicURL), enabled: true)
      publicItem.toolTip = url.absoluteString
      menu.addItem(publicItem)
    }
    menu.addItem(item("Afficher les journaux", #selector(showLogs), enabled: true))
    menu.addItem(.separator())

    let autoStart = item("Lancer le serveur à l'ouverture de l'app", #selector(toggleAutoStart), enabled: true)
    autoStart.state = AppSettings.startServerOnLaunch ? .on : .off
    menu.addItem(autoStart)
    let login = item("Ouvrir à la connexion", #selector(toggleOpenAtLogin), enabled: true)
    switch SMAppService.mainApp.status {
    case .enabled: login.state = .on
    case .requiresApproval: login.state = .mixed
    default: login.state = .off
    }
    menu.addItem(login)
    menu.addItem(.separator())

    menu.addItem(item("Quitter (arrête le serveur)", #selector(quit), enabled: true, key: "q"))
  }

  private func item(_ title: String, _ action: Selector, enabled: Bool, key: String = "") -> NSMenuItem {
    let item = NSMenuItem(title: title, action: enabled ? action : nil, keyEquivalent: key)
    item.target = self
    item.isEnabled = enabled
    return item
  }

  // MARK: Actions

  @objc private func startServer() {
    if FileManager.default.fileExists(atPath: AppSettings.entryPointURL.path) {
      supervisor.start()
    } else {
      rebuildAndRestart()
    }
  }

  @objc private func stopServer() {
    supervisor.stop()
  }

  @objc private func restartServer() {
    supervisor.restart()
  }

  /// The running server keeps serving during the build and is only restarted once it succeeds.
  @objc private func rebuildAndRestart() {
    builder.build { [weak self] success, tail in
      guard let self else { return }
      if success {
        self.supervisor.restart()
      } else {
        self.showAlert(title: "La compilation a échoué", text: tail)
      }
    }
  }

  @objc private func openDashboard() {
    NSWorkspace.shared.open(AppSettings.dashboardURL)
  }

  @objc private func openPublicURL() {
    if let url = AppSettings.publicURL() { NSWorkspace.shared.open(url) }
  }

  @objc private func showLogs() {
    let console = URL(fileURLWithPath: "/System/Applications/Utilities/Console.app")
    NSWorkspace.shared.open([AppSettings.logURL], withApplicationAt: console, configuration: NSWorkspace.OpenConfiguration())
  }

  @objc private func toggleAutoStart() {
    AppSettings.startServerOnLaunch.toggle()
  }

  @objc private func toggleOpenAtLogin() {
    let service = SMAppService.mainApp
    do {
      switch service.status {
      case .enabled: try service.unregister()
      case .requiresApproval: SMAppService.openSystemSettingsLoginItems()
      default: try service.register()
      }
    } catch {
      showAlert(title: "Impossible de changer « Ouvrir à la connexion »", text: error.localizedDescription)
    }
  }

  @objc private func quit() {
    NSApp.terminate(nil)
  }

  private func showAlert(title: String, text: String) {
    let alert = NSAlert()
    alert.messageText = title
    alert.informativeText = text
    alert.alertStyle = .warning
    NSApp.activate(ignoringOtherApps: true)
    alert.runModal()
  }
}
