// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "MesDepartsCore",
    platforms: [
        .iOS(.v16),
        .macOS(.v13)
    ],
    products: [
        .library(
            name: "MesDepartsCore",
            targets: ["MesDepartsCore"]
        )
    ],
    dependencies: [
        .package(url: "https://github.com/apple/swift-testing.git", exact: "0.99.0")
    ],
    targets: [
        .target(
            name: "MesDepartsCore"
        ),
        .testTarget(
            name: "MesDepartsCoreTests",
            dependencies: [
                "MesDepartsCore",
                .product(name: "Testing", package: "swift-testing")
            ]
        )
    ]
)
