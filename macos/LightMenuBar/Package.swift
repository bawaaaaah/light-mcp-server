// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "LightMenuBar",
  platforms: [.macOS(.v13)],
  targets: [
    .executableTarget(name: "LightMenuBar")
  ]
)
