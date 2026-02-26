# MesDepartsApp (SwiftUI)

## Navigation Flow

The app now opens on stop search and uses this flow:

1. `StopSearchView`
2. `StationboardView`
3. `DepartureDetailView`

Root container is `NavigationStack` in `App/ContentView.swift`.

## Screens

### StopSearchView

- Search field with debounce (`350ms`)
- Minimum query length: `2`
- Results list from `GET /api/stops/search`
- Selecting a result navigates to stationboard for the mapped stop id

Stop-id mapping follows core model logic (`stationboardStopId`):
- `stationId` -> `group_id` -> `stop_id` -> fallbacks

### StationboardView

- Header shows resolved station name and response freshness hints
- Departures list from `GET /api/stationboard`
- Pull-to-refresh supported via `.refreshable`
- Polling behavior:
  - starts on view `onAppear`
  - stops on view `onDisappear`
  - interval is fixed at `20s` (conservative, no burst increase)
  - maximum one in-flight fetch at a time

### DepartureDetailView

- Shows key departure fields (service, timing, stop, identifiers)
- In `DEBUG` builds, shows a raw JSON excerpt for the selected departure when available

## MesDepartsCore Integration

- Uses existing `StopSearchAPI` and `StationboardAPI`
- Added non-breaking wrapper:
  - `StationboardAPI.fetchStationboardPayload(...)`
  - returns decoded response + raw payload data
- Existing `fetchStationboard(...)` remains unchanged

## How To Test In Xcode

1. Open `ios/MesDepartsApp/MesDepartsApp.xcodeproj`
2. Select scheme `MesDepartsApp`
3. Run on iOS Simulator
4. In search, type at least 2 characters (example: `lausanne`)
5. Tap a result and confirm stationboard loads
6. Stay on stationboard for >20s and confirm periodic refresh continues
7. Navigate to a departure detail and back:
   - refresh must stop while detail is shown
   - refresh resumes when stationboard re-appears
8. Pull down on stationboard list to trigger manual refresh

## Command-Line Build Check

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
