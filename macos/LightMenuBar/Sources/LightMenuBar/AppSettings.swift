// Adapted from wing-mcp-server (MIT, https://github.com/bawaaaaah/wing-mcp-server), macos/WingMenuBar.
import Foundation

/// Where the server lives and how to run it. Each value can be overridden with
/// `defaults write com.bawaaaaah.light-mcp-menubar <key> <value>`; otherwise it falls back to what
/// build-app.sh baked into Info.plist when the app was built from the checkout.
enum AppSettings {
  private static var defaults: UserDefaults { .standard }

  static var repoURL: URL {
    let path = defaults.string(forKey: "repoPath") ?? infoString("LightRepoPath") ?? ""
    return URL(fileURLWithPath: (path as NSString).expandingTildeInPath, isDirectory: true)
  }

  static var nodeURL: URL {
    let path = defaults.string(forKey: "nodePath") ?? infoString("LightNodePath") ?? "/usr/local/bin/node"
    return URL(fileURLWithPath: (path as NSString).expandingTildeInPath)
  }

  /// A `port` default overrides `server.port` of data/machine/config.json (the server's own
  /// setting, see src/core/env.ts), which overrides 8790.
  static var port: Int {
    if let port = portOverride { return port }
    if let port = serverConfig()?["port"] as? Int, port > 0, port <= 65535 { return port }
    return 8790
  }

  private static var portOverride: Int? {
    let port = defaults.integer(forKey: "port")
    return port > 0 ? port : nil
  }

  /// Where this Mac reaches the server: `server.host` when it names one interface, else loopback.
  static var localHost: String {
    guard let host = (serverConfig()?["host"] as? String)?.trimmingCharacters(in: .whitespaces),
      !host.isEmpty, host != "0.0.0.0", host != "::"
    else { return "127.0.0.1" }
    return host.contains(":") ? "[\(host)]" : host
  }

  static var startServerOnLaunch: Bool {
    get { defaults.object(forKey: "startServerOnLaunch") as? Bool ?? true }
    set { defaults.set(newValue, forKey: "startServerOnLaunch") }
  }

  /// `node <entryPoint> serve`, the same as `npm start`.
  static let entryPoint = "dist/cli/main.js"
  static var entryPointURL: URL { repoURL.appendingPathComponent(entryPoint) }
  /// The checkout's data/ folder, as src/core/paths.ts resolves it for a source checkout.
  static var dataURL: URL { repoURL.appendingPathComponent("data", isDirectory: true) }
  static var logURL: URL { dataURL.appendingPathComponent("prod.log") }
  static var pidURL: URL { dataURL.appendingPathComponent("menubar.pid") }
  /// The web UI, logged in with the master token (`#token=`, read by web/src/api.ts).
  static var dashboardURL: URL { withToken(URL(string: "http://\(localHost):\(port)/")!) }

  /// The `server` section of data/machine/config.json.
  private static func serverConfig() -> [String: Any]? {
    guard
      let data = try? Data(contentsOf: dataURL.appendingPathComponent("machine/config.json")),
      let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    else { return nil }
    return json["server"] as? [String: Any]
  }

  /// `server.authToken`: the master token the server persisted on its first start.
  static var authToken: String? { serverConfig()?["authToken"] as? String }

  /// The URL with `#token=<authToken>`; the fragment never reaches the server or its logs.
  private static func withToken(_ url: URL) -> URL {
    guard let token = authToken,
      let encoded = token.addingPercentEncoding(withAllowedCharacters: .urlFragmentAllowed),
      var components = URLComponents(url: url, resolvingAgainstBaseURL: false)
    else { return url }
    components.percentEncodedFragment = "token=\(encoded)"
    return components.url ?? url
  }

  /// `server.publicUrl` from data/machine/config.json, unless it is just the localhost default.
  static func publicURL() -> URL? {
    guard
      let value = serverConfig()?["publicUrl"] as? String,
      let url = URL(string: value),
      let host = url.host,
      host != "localhost", host != "127.0.0.1"
    else { return nil }
    return withToken(url)
  }

  /// The environment for node and npm: what the app inherited, with node's own directory first on
  /// PATH, because an app opened from the Finder or at login gets a bare /usr/bin:/bin.
  static func childEnvironment() -> [String: String] {
    var env = ProcessInfo.processInfo.environment
    let nodeDir = nodeURL.resolvingSymlinksInPath().deletingLastPathComponent().path
    let inherited = env["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin"
    env["PATH"] = "\(nodeDir):\(nodeURL.deletingLastPathComponent().path):\(inherited)"
    // Without an override the server reads server.port itself; an inherited PORT would beat it.
    if let port = portOverride { env["PORT"] = String(port) } else { env.removeValue(forKey: "PORT") }
    return env
  }

  private static func infoString(_ key: String) -> String? {
    guard let value = Bundle.main.object(forInfoDictionaryKey: key) as? String, !value.isEmpty else {
      return nil
    }
    return value
  }
}
