# iOS Setup

## Project Layout

- `ios/MesDepartsCore/`: Swift Package for networking + models.
- `ios/MesDepartsIOSApp/MesDepartsIOSApp.xcodeproj`: minimal iOS app target using local package dependency `../MesDepartsCore`.

## Open In Xcode

1. Open `ios/MesDepartsIOSApp/MesDepartsIOSApp.xcodeproj`.
2. Select scheme `MesDepartsIOSApp`.
3. Build/run on Simulator or a real device.

## Signing (Real iPhone)

1. In Xcode, select target `MesDepartsIOSApp` -> `Signing & Capabilities`.
2. Set `Team` to your Apple Developer team.
3. Keep `Automatically manage signing` enabled.
4. Use a unique Bundle Identifier (for example `ch.mesdeparts.iosapp.<yourname>`).

## Real Device Prerequisites

1. Connect iPhone to Mac and trust the computer.
2. On iPhone, enable `Developer Mode` (Settings -> Privacy & Security).
3. If prompted, trust your developer certificate on device.
4. Run from Xcode with your iPhone selected.

## Command-Line Build Check

```bash
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
xcodebuild \
  -project ios/MesDepartsIOSApp/MesDepartsIOSApp.xcodeproj \
  -scheme MesDepartsIOSApp \
  -destination 'generic/platform=iOS' \
  build
```

If you do not have a signing team configured yet, use:

```bash
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
xcodebuild \
  -project ios/MesDepartsIOSApp/MesDepartsIOSApp.xcodeproj \
  -scheme MesDepartsIOSApp \
  -destination 'generic/platform=iOS' \
  CODE_SIGNING_ALLOWED=NO \
  build
```
