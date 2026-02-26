# App Store Release Checklist (iOS)

Use this checklist before each production submission.

## 1) Project & Build

- [ ] Open `ios/MesDepartsApp/MesDepartsApp.xcodeproj`
- [ ] Scheme is `MesDepartsApp`
- [ ] Build configuration is `Release`
- [ ] iOS deployment target is `16.0+`
- [ ] Unsigned release build passes:
  - `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild -project ios/MesDepartsApp/MesDepartsApp.xcodeproj -scheme MesDepartsApp -configuration Release -destination 'generic/platform=iOS' CODE_SIGNING_ALLOWED=NO build`

## 2) Signing & Bundle

- [ ] `Team` selected in Signing & Capabilities
- [ ] Unique production bundle identifier set (replace placeholder `ch.mesdeparts.app` if needed)
- [ ] Version (`MARKETING_VERSION`) and build number (`CURRENT_PROJECT_VERSION`) updated

## 3) Privacy & Permissions

- [ ] `PrivacyInfo.xcprivacy` included in app target:
  - `NSPrivacyTracking = false`
  - no tracking domains
  - diagnostics declared as non-tracking
  - required-reason API declaration present for `UserDefaults` usage (`CA92.1`)
- [ ] `Info.plist` contains no unused permission keys:
  - no location permission keys
  - no camera/microphone/photos permissions unless intentionally added later
- [ ] No analytics SDK added unintentionally

## 4) Localization

- [ ] String Catalog scaffold exists: `ios/MesDepartsApp/App/Localizable.xcstrings`
- [ ] Languages scaffolded: `en`, `fr`, `de`, `it`
- [ ] Critical user-facing labels verified in each language

## 5) App Icon & Launch

- [ ] App icon slots are fully populated in `AppIcon.appiconset`
- [ ] 1024x1024 marketing icon is final quality (no alpha)
- [ ] See icon notes in `ios/MesDepartsApp/App/Assets.xcassets/AppIcon.appiconset/README.md`
- [ ] Launch screen renders correctly on iPhone and iPad

## 6) Functional Sanity

- [ ] Flow works: Stop Search -> Stationboard -> Departure Detail
- [ ] Polling does not overlap requests
- [ ] Polling pauses in background and resumes on foreground
- [ ] Diagnostics screen shows freshness samples and cadence stats
- [ ] `swift test` passes in `ios/MesDepartsCore`

## 7) Archive & TestFlight

- [ ] Archive created from Xcode (`Product -> Archive`)
- [ ] Archive validates successfully in Organizer
- [ ] Upload to App Store Connect completed
- [ ] TestFlight internal build available and installable
- [ ] Basic smoke test passed on TestFlight build (search, stationboard, diagnostics, language toggle)
