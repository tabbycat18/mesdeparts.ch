# iOS Setup

## Project Layout

- `ios/MesDepartsCore/`: Swift Package for networking + models.
- `ios/MesDepartsApp/MesDepartsApp.xcodeproj`: iOS app target for Run/Archive using local package dependency `../MesDepartsCore`.

## Open In Xcode

1. Open `ios/MesDepartsApp/MesDepartsApp.xcodeproj`.
2. Select scheme `MesDepartsApp`.
3. Select an iOS Simulator and press Run.

## Configure Signing (Required for device + App Store archive)

1. In Xcode, select target `MesDepartsApp` -> `Signing & Capabilities`.
2. Set `Team` to your Apple Developer team.
3. Keep `Automatically manage signing` enabled.
4. Set a final unique bundle identifier (default placeholder is `ch.mesdeparts.app`).

## Archive In Xcode (App Store flow)

1. Select scheme `MesDepartsApp`.
2. Set destination to `Any iOS Device (arm64)`.
3. Set Build Configuration to `Release`.
4. Run `Product -> Archive`.
5. In Organizer, validate/distribute to App Store Connect.
6. In App Store Connect -> TestFlight, wait for processing and assign the build to internal testers.

## TestFlight Steps (Detailed)

1. Open Xcode Organizer and select the latest `MesDepartsApp` archive.
2. Click `Distribute App` -> `App Store Connect` -> `Upload`.
3. Keep default upload options unless you have a specific compliance requirement.
4. After upload, open App Store Connect -> `My Apps` -> `MesDeparts` -> `TestFlight`.
5. Wait for build processing and any compliance prompts.
6. Add internal testers and enable testing for the uploaded build.
7. Install from TestFlight and run a quick smoke test:
   - stop search
   - stationboard polling/resume behavior
   - diagnostics screen
   - More menu language/display mode

## Command-Line Build/Archive Checks

Unsigned Release build (CI/local validation):

```bash
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
xcodebuild \
  -project ios/MesDepartsApp/MesDepartsApp.xcodeproj \
  -scheme MesDepartsApp \
  -configuration Release \
  -destination 'generic/platform=iOS' \
  CODE_SIGNING_ALLOWED=NO \
  build
```

Unsigned archive structure check:

```bash
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
xcodebuild \
  -project ios/MesDepartsApp/MesDepartsApp.xcodeproj \
  -scheme MesDepartsApp \
  -configuration Release \
  -destination 'generic/platform=iOS' \
  -archivePath /tmp/MesDepartsApp.xcarchive \
  CODE_SIGNING_ALLOWED=NO \
  archive
```

## How To Verify Freshness

1. Run `MesDepartsApp` and open a stop stationboard.
2. Open the top-right ellipsis menu (`More`) and tap `Diagnostics`.
3. Verify `Last sample` includes:
   - `requestStart` / `requestEnd` / `client fetch ms`
   - `meta.serverTime`, `meta.rtFetchedAt`, `meta.rtCacheAgeMs`, `meta.rtStatus`, `meta.responseMode`
   - `stopID`
4. Leave stationboard open for at least 1 minute and verify:
   - `Avg cadence` is around 20s (small jitter expected)
   - `% rtStatus != applied` updates from real responses
   - sample count increases and caps at 50 over time
5. Send app to background for ~30s, then return to foreground:
   - polling should stop in background
   - polling should resume on foreground without overlapping requests

## App Store Compliance Notes

- Privacy manifest is included at `ios/MesDepartsApp/App/PrivacyInfo.xcprivacy`.
- String Catalog scaffold is included at `ios/MesDepartsApp/App/Localizable.xcstrings` (`en`, `fr`, `de`, `it`).
- App icon placeholder slots are declared in `AppIcon.appiconset`; replace all slots before release.
- Release checklist: `ios/APP_STORE_CHECKLIST.md`.

## Core Test Guardrails

Run MesDepartsCore tests (includes cache-policy and timeout checks):

```bash
cd ios/MesDepartsCore
swift test
```
