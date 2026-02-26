import SwiftUI
import MesDepartsCore

struct ContentView: View {
    var body: some View {
        NavigationStack {
            StopSearchView()
        }
    }
}

private struct StopSearchView: View {
    @StateObject private var viewModel = StopSearchViewModel()
    @AppStorage(AppPreferencesKeys.language) private var languageRawValue = AppLanguageOption.en.rawValue

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: MDDesignSystem.Spacing.lg) {
                BlueCard {
                    VStack(alignment: .leading, spacing: MDDesignSystem.Spacing.sm) {
                        SectionHeader(title: appLabel(.stopSearch, language: language))

                        TextField(appLabel(.searchPlaceholder, language: language), text: $viewModel.query)
                            .textInputAutocapitalization(.never)
                            .disableAutocorrection(true)
                            .submitLabel(.search)
                            .onSubmit { viewModel.scheduleSearch() }
                            .padding(.horizontal, MDDesignSystem.Spacing.sm)
                            .padding(.vertical, MDDesignSystem.Spacing.xs)
                            .background(MDDesignSystem.Colors.background)
                            .overlay(
                                RoundedRectangle(cornerRadius: 10, style: .continuous)
                                    .stroke(MDDesignSystem.Colors.stroke, lineWidth: 1)
                            )
                            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))

                        if viewModel.queryTrimmed.count < 2 {
                            Text(appLabel(.typeAtLeastTwoCharacters, language: language))
                                .font(.footnote)
                                .foregroundStyle(MDDesignSystem.Colors.textSecondary)
                        } else if viewModel.isSearching {
                            HStack(spacing: MDDesignSystem.Spacing.xs) {
                                ProgressView()
                                Text(appLabel(.searching, language: language))
                                    .font(.footnote)
                                    .foregroundStyle(MDDesignSystem.Colors.textSecondary)
                            }
                        } else if let errorMessage = viewModel.errorMessage {
                            Text(errorMessage)
                                .font(.footnote)
                                .foregroundStyle(.red)
                        } else if viewModel.results.isEmpty {
                            Text(appLabel(.noMatchingStops, language: language))
                                .font(.footnote)
                                .foregroundStyle(MDDesignSystem.Colors.textSecondary)
                        }
                    }
                }

                if !viewModel.results.isEmpty {
                    SectionHeader(
                        title: appLabel(.results, language: language),
                        subtitle: "\(viewModel.results.count)"
                    )

                    LazyVStack(spacing: MDDesignSystem.Spacing.sm) {
                        ForEach(viewModel.results) { stop in
                            NavigationLink {
                                StationboardView(stop: stop)
                            } label: {
                                BlueCard {
                                    VStack(alignment: .leading, spacing: MDDesignSystem.Spacing.xs) {
                                        Text(stop.displayName)
                                            .font(.headline)
                                            .foregroundStyle(MDDesignSystem.Colors.textPrimary)

                                        if let subtitle = stop.subtitle {
                                            Text(subtitle)
                                                .font(.footnote)
                                                .foregroundStyle(MDDesignSystem.Colors.textSecondary)
                                        }
                                    }
                                }
                            }
                            .buttonStyle(.plain)
                            .accessibilityElement(children: .combine)
                            .accessibilityHint("Open stationboard")
                        }
                    }
                }
            }
            .padding(MDDesignSystem.Spacing.md)
        }
        .background(MDDesignSystem.Colors.background.ignoresSafeArea())
        .navigationTitle("MesDeparts")
        .onChange(of: viewModel.query) { _ in
            viewModel.scheduleSearch()
        }
    }

    private var language: AppLanguageOption {
        AppLanguageOption(rawValue: languageRawValue) ?? .en
    }
}

private struct StationboardView: View {
    let stop: StopChoice
    @StateObject private var viewModel: StationboardViewModel
    @State private var activeSheet: MoreSheetDestination?
    @Environment(\.scenePhase) private var scenePhase
    @AppStorage(AppPreferencesKeys.displayMode) private var displayModeRawValue = DisplayModeOption.line.rawValue
    @AppStorage(AppPreferencesKeys.language) private var languageRawValue = AppLanguageOption.en.rawValue
    @AppStorage(AppPreferencesKeys.includeAlerts) private var includeAlertsEnabled = true

    init(stop: StopChoice) {
        self.stop = stop
        _viewModel = StateObject(wrappedValue: StationboardViewModel(stop: stop))
    }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: MDDesignSystem.Spacing.lg) {
                BoardHeaderView(
                    stationName: viewModel.stationName,
                    subtitle: headerSubtitle,
                    updatedAt: viewModel.lastUpdatedAt,
                    freshnessLabel: viewModel.freshnessLabel,
                    updatedLabel: appLabel(.updatedLabel, language: language)
                )

                if !viewModel.servedLines.isEmpty {
                    VStack(alignment: .leading, spacing: MDDesignSystem.Spacing.sm) {
                        SectionHeader(title: appLabel(.servedByLines, language: language))

                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: MDDesignSystem.Spacing.xs) {
                                ForEach(viewModel.servedLines, id: \.self) { line in
                                    LinePill(line: line)
                                }
                            }
                            .padding(.vertical, MDDesignSystem.Spacing.xxs)
                        }
                    }
                }

                if viewModel.isLoading && viewModel.departures.isEmpty {
                    BlueCard {
                        HStack(spacing: MDDesignSystem.Spacing.xs) {
                            ProgressView()
                            Text(appLabel(.loadingDepartures, language: language))
                                .font(.footnote)
                                .foregroundStyle(MDDesignSystem.Colors.textSecondary)
                        }
                    }
                }

                if let errorMessage = viewModel.errorMessage {
                    BlueCard {
                        Text(errorMessage)
                            .font(.footnote)
                            .foregroundStyle(.red)
                    }
                }

                VStack(alignment: .leading, spacing: MDDesignSystem.Spacing.sm) {
                    SectionHeader(
                        title: appLabel(.departures, language: language),
                        subtitle: "\(viewModel.departures.count)"
                    )

                    LazyVStack(spacing: MDDesignSystem.Spacing.sm) {
                        ForEach(viewModel.departures) { item in
                            NavigationLink {
                                DepartureDetailView(
                                    departure: item.departure,
                                    rawJSONExcerpt: item.rawJSONExcerpt
                                )
                            } label: {
                                DepartureRowView(
                                    departure: item.departure,
                                    displayMode: displayMode,
                                    language: language
                                )
                            }
                            .buttonStyle(.plain)
                            .accessibilityHint("Open departure details")
                        }
                    }
                }
            }
            .padding(MDDesignSystem.Spacing.md)
        }
        .background(MDDesignSystem.Colors.background.ignoresSafeArea())
        .navigationTitle(viewModel.stationName)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                MoreMenuButton(
                    presentedSheet: $activeSheet,
                    displayModeRawValue: $displayModeRawValue,
                    languageRawValue: $languageRawValue
                )
            }
        }
        .sheet(item: $activeSheet) { destination in
            NavigationStack {
                sheetView(for: destination)
            }
        }
        .refreshable {
            await viewModel.refreshNow()
        }
        .onAppear {
            viewModel.setIncludeAlertsEnabled(includeAlertsEnabled)
            handleScenePhase(scenePhase)
        }
        .onDisappear {
            viewModel.stopPolling()
        }
        .onChange(of: scenePhase) { newPhase in
            handleScenePhase(newPhase)
        }
        .onChange(of: includeAlertsEnabled) { newValue in
            viewModel.setIncludeAlertsEnabled(newValue)
            if scenePhase == .active {
                Task {
                    await viewModel.refreshNow()
                }
            }
        }
    }

    private var language: AppLanguageOption {
        AppLanguageOption(rawValue: languageRawValue) ?? .en
    }

    private var displayMode: DisplayModeOption {
        DisplayModeOption(rawValue: displayModeRawValue) ?? .line
    }

    @ViewBuilder
    private func sheetView(for destination: MoreSheetDestination) -> some View {
        switch destination {
        case .favorites:
            FavoritesPlaceholderView()
        case .filters:
            FiltersPlaceholderView()
        case .diagnostics:
            FreshnessDiagnosticsView(diagnostics: viewModel.freshnessDiagnostics)
        case .about:
            AboutInfoView()
        }
    }

    private func handleScenePhase(_ phase: ScenePhase) {
        switch phase {
        case .active:
            viewModel.startPolling()
        case .inactive, .background:
            viewModel.stopPolling()
        @unknown default:
            viewModel.stopPolling()
        }
    }

    private var headerSubtitle: String? {
        switch language {
        case .fr:
            return "Vos prochains departs"
        case .de:
            return "Ihre nachsten Abfahrten"
        case .it:
            return "Le tue prossime partenze"
        case .en:
            return "Your next departures"
        }
    }
}

private struct DepartureDetailView: View {
    let departure: Departure
    let rawJSONExcerpt: String?

    var body: some View {
        List {
            Section("Service") {
                KeyValueRow(label: "Line", value: nonEmpty(departure.line))
                KeyValueRow(label: "Category", value: nonEmpty(departure.category))
                KeyValueRow(label: "Number", value: nonEmpty(departure.number))
                KeyValueRow(label: "Destination", value: nonEmpty(departure.destination))
            }

            Section("Timing") {
                KeyValueRow(label: "Scheduled", value: DateFormatters.dateTime(departure.scheduledDeparture))
                KeyValueRow(label: "Realtime", value: DateFormatters.dateTime(departure.realtimeDeparture))
                KeyValueRow(label: "Delay", value: delayLabel(departure.delayMin))
                KeyValueRow(label: "Status", value: nonEmpty(departure.status))
                KeyValueRow(label: "Cancelled", value: departure.cancelled ? "Yes" : "No")
            }

            Section("Stop") {
                KeyValueRow(label: "Platform", value: nonEmpty(departure.platform))
                KeyValueRow(label: "Platform Changed", value: boolLabel(departure.platformChanged))
                KeyValueRow(label: "Previous Platform", value: nonEmpty(departure.previousPlatform))
                KeyValueRow(label: "Stop ID", value: nonEmpty(departure.stopID))
                KeyValueRow(label: "Stop Sequence", value: intLabel(departure.stopSequence))
            }

            Section("Identifiers") {
                KeyValueRow(label: "Departure Key", value: nonEmpty(departure.key))
                KeyValueRow(label: "Trip ID", value: nonEmpty(departure.tripID))
                KeyValueRow(label: "Route ID", value: nonEmpty(departure.routeID))
                KeyValueRow(label: "Cancel Reason", value: nonEmpty(departure.cancelReasonCode))
                KeyValueRow(label: "Replacement Type", value: nonEmpty(departure.replacementType))
                KeyValueRow(label: "Flags", value: flagsLabel(departure.flags))
            }

#if DEBUG
            if let rawJSONExcerpt, !rawJSONExcerpt.isEmpty {
                Section("Raw JSON (Debug)") {
                    Text(rawJSONExcerpt)
                        .font(.system(.caption, design: .monospaced))
                        .textSelection(.enabled)
                }
            }
#endif
        }
        .navigationTitle(nonEmpty(departure.line))
        .navigationBarTitleDisplayMode(.inline)
    }

    private func nonEmpty(_ value: String?) -> String {
        guard let value, !value.isEmpty else { return "n/a" }
        return value
    }

    private func intLabel(_ value: Int?) -> String {
        guard let value else { return "n/a" }
        return String(value)
    }

    private func boolLabel(_ value: Bool?) -> String {
        guard let value else { return "n/a" }
        return value ? "Yes" : "No"
    }

    private func delayLabel(_ value: Int?) -> String {
        guard let value else { return "n/a" }
        if value == 0 {
            return "On time"
        }
        return value > 0 ? "+\(value) min" : "\(value) min"
    }

    private func flagsLabel(_ values: [String]?) -> String {
        guard let values, !values.isEmpty else { return "n/a" }
        return values.joined(separator: ", ")
    }
}

private struct DepartureRowView: View {
    let departure: Departure
    let displayMode: DisplayModeOption
    let language: AppLanguageOption

    var body: some View {
        BlueCard {
            Group {
                if displayMode == .line {
                    lineModeLayout
                } else {
                    minModeLayout
                }
            }
            .padding(.vertical, 2)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilitySummary)
    }

    private var primaryDate: Date? {
        departure.realtimeDeparture ?? departure.scheduledDeparture
    }

    private var serviceLabel: String {
        if let line = departure.line, !line.isEmpty {
            return line
        }
        if let number = departure.number, !number.isEmpty {
            return number
        }
        return appLabel(.displayModeLine, language: language)
    }

    private var destinationLabel: String {
        if let destination = departure.destination, !destination.isEmpty {
            return destination
        }
        return "Destination unavailable"
    }

    private var platformLabel: String {
        guard let platform = departure.platform, !platform.isEmpty else {
            return appLabel(.platformUnavailable, language: language)
        }
        return "Platform \(platform)"
    }

    private var delayText: String? {
        guard let delay = departure.delayMin else { return nil }
        if delay == 0 {
            return "On time"
        }
        return delay > 0 ? "+\(delay) min" : "\(delay) min"
    }

    private var lineModeLayout: some View {
        VStack(alignment: .leading, spacing: MDDesignSystem.Spacing.xxs) {
            topBoardRow(timeFont: .title3.weight(.semibold))
            secondaryRow()
        }
    }

    private var minModeLayout: some View {
        VStack(alignment: .leading, spacing: MDDesignSystem.Spacing.xxs) {
            topBoardRow(timeFont: .title3.weight(.semibold))
            secondaryRow(showMinutes: true)
        }
    }

    private var tagsRow: some View {
        HStack(spacing: MDDesignSystem.Spacing.xs) {
            if let delayText {
                TagPill(text: delayText, style: .delay)
            }
            if departure.cancelled {
                TagPill(text: "Cancelled", style: .cancelled)
            }
            if let platform = departure.platform, !platform.isEmpty {
                TagPill(text: "Plt \(platform)", style: .platform)
            }
            if departure.realtimeDeparture != nil {
                TagPill(text: "RT", style: .realtime)
            }
        }
    }

    private func topBoardRow(timeFont: Font) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: MDDesignSystem.Spacing.sm) {
            LinePill(line: serviceLabel)
                .frame(width: 88, alignment: .leading)

            Text(destinationLabel)
                .font(.body)
                .foregroundStyle(MDDesignSystem.Colors.textPrimary)
                .lineLimit(1)
                .truncationMode(.tail)
                .frame(maxWidth: .infinity, alignment: .leading)

            Text(DateFormatters.time(primaryDate))
                .font(timeFont)
                .foregroundStyle(MDDesignSystem.Colors.textPrimary)
                .monospacedDigit()
                .frame(width: 64, alignment: .trailing)
        }
    }

    private func secondaryRow(showMinutes: Bool = false) -> some View {
        HStack(alignment: .center, spacing: MDDesignSystem.Spacing.xs) {
            if showMinutes {
                Text(minutesLabel)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(MDDesignSystem.Colors.accent)
                    .monospacedDigit()
            }
            tagsRow
                .lineLimit(1)
            Spacer(minLength: 0)
        }
    }

    private var minutesLabel: String {
        guard let primaryDate else {
            return "--"
        }
        let interval = primaryDate.timeIntervalSinceNow
        let minutes = max(0, Int((interval + 59) / 60))
        return "\(minutes) \(appLabel(.minuteSuffix, language: language))"
    }

    private var accessibilitySummary: String {
        var parts: [String] = [
            serviceLabel,
            destinationLabel,
            DateFormatters.time(primaryDate)
        ]

        if let delayText {
            parts.append(delayText)
        }
        if departure.cancelled {
            parts.append("Cancelled")
        }
        return parts.joined(separator: ", ")
    }
}

private struct KeyValueRow: View {
    let label: String
    let value: String

    var body: some View {
        HStack {
            Text(label)
                .foregroundStyle(.secondary)
            Spacer()
            Text(value)
                .multilineTextAlignment(.trailing)
        }
    }
}

private struct StopChoice: Identifiable, Hashable, Sendable {
    let id: String
    let displayName: String
    let stationboardStopID: String
    let subtitle: String?

    init?(result: StopSearchResult) {
        guard let stationboardStopID = result.stationboardStopId else {
            return nil
        }
        let cleanedDisplayName = Self.firstNonEmpty(
            result.name,
            result.stationName,
            result.stopName
        ) ?? stationboardStopID

        self.stationboardStopID = stationboardStopID
        self.displayName = cleanedDisplayName
        self.id = "\(stationboardStopID)|\(cleanedDisplayName)"

        let locationBits: [String] = [result.city, result.canton].compactMap { value in
            guard let value, !value.isEmpty else { return nil }
            return value
        }
        self.subtitle = locationBits.isEmpty ? nil : locationBits.joined(separator: " | ")
    }

    private static func firstNonEmpty(_ values: String?...) -> String? {
        for value in values {
            if let value, !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                return value
            }
        }
        return nil
    }
}

private struct DepartureDisplay: Identifiable {
    let id: String
    let departure: Departure
    let rawJSONExcerpt: String?
}

@MainActor
private final class StopSearchViewModel: ObservableObject {
    @Published var query = ""
    @Published var results: [StopChoice] = []
    @Published var isSearching = false
    @Published var errorMessage: String?

    private let api = StopSearchAPI(baseURL: .production, httpClient: HTTPClient(timeout: 8))
    private var searchTask: Task<Void, Never>?

    private static let debounceNanoseconds: UInt64 = 350_000_000
    private static let minimumQueryLength = 2
    private static let searchLimit = 20

    var queryTrimmed: String {
        query.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    deinit {
        searchTask?.cancel()
    }

    func scheduleSearch() {
        let trimmed = queryTrimmed
        searchTask?.cancel()

        guard trimmed.count >= Self.minimumQueryLength else {
            isSearching = false
            errorMessage = nil
            results = []
            return
        }

        isSearching = true
        errorMessage = nil

        searchTask = Task { [weak self] in
            guard let self else { return }

            do {
                try await Task.sleep(nanoseconds: Self.debounceNanoseconds)
            } catch {
                return
            }
            guard !Task.isCancelled else { return }

            do {
                let matches = try await self.api.searchStops(
                    query: trimmed,
                    limit: Self.searchLimit
                )
                guard !Task.isCancelled else { return }
                guard trimmed == self.queryTrimmed else { return }

                self.results = matches.compactMap(StopChoice.init)
                self.errorMessage = nil
                self.isSearching = false
            } catch is CancellationError {
                return
            } catch {
                guard trimmed == self.queryTrimmed else { return }
                self.results = []
                self.errorMessage = Self.errorMessage(for: error)
                self.isSearching = false
            }
        }
    }

    private static func errorMessage(for error: Error) -> String {
        if let clientError = error as? HTTPClientError {
            switch clientError {
            case .invalidURL:
                return "Invalid stop-search URL."
            case .invalidResponse:
                return "Stop-search response was invalid."
            case .unexpectedStatusCode(let code):
                if code == 400 {
                    return "Query is too short."
                }
                return "Stop-search failed (HTTP \(code))."
            }
        }
        return "Stop-search failed: \(error.localizedDescription)"
    }
}

@MainActor
private final class StationboardViewModel: ObservableObject {
    @Published var stationName: String
    @Published var departures: [DepartureDisplay] = []
    @Published var isLoading = false
    @Published var errorMessage: String?
    @Published var freshnessLabel: String?
    @Published var servedLines: [String] = []
    @Published var lastUpdatedAt: Date?
    @Published var freshnessDiagnostics = FreshnessDiagnosticsBuffer()

    private let stop: StopChoice
    private let api = StationboardAPI(baseURL: .production, httpClient: HTTPClient(timeout: 12))
    private var pollingTask: Task<Void, Never>?
    private var isFetching = false
    private var includeAlertsEnabled = true

    private static let pollBaseNanoseconds: UInt64 = 20_000_000_000
    private static let pollJitterNanoseconds: UInt64 = 2_000_000_000
    private static let boardLimit = 20

    init(stop: StopChoice) {
        self.stop = stop
        self.stationName = stop.displayName
    }

    deinit {
        pollingTask?.cancel()
    }

    func startPolling() {
        guard pollingTask == nil else { return }

        pollingTask = Task { [weak self] in
            guard let self else { return }
            await self.fetchBoard()

            while !Task.isCancelled {
                do {
                    try await Task.sleep(nanoseconds: Self.jitteredPollNanoseconds())
                } catch {
                    break
                }
                guard !Task.isCancelled else { break }
                await self.fetchBoard()
            }
        }
    }

    func stopPolling() {
        pollingTask?.cancel()
        pollingTask = nil
    }

    func refreshNow() async {
        await fetchBoard()
    }

    func setIncludeAlertsEnabled(_ enabled: Bool) {
        includeAlertsEnabled = enabled
    }

    private func fetchBoard() async {
        guard !isFetching else { return }
        isFetching = true
        let requestStart = Date()
        var responseMeta: Meta?
        if departures.isEmpty {
            isLoading = true
        }

        defer {
            freshnessDiagnostics.append(
                FreshnessDiagnosticSample(
                    requestStart: requestStart,
                    requestEnd: Date(),
                    meta: responseMeta,
                    stopID: stop.stationboardStopID
                )
            )
            isFetching = false
            isLoading = false
        }

        do {
            let payload = try await api.fetchStationboardPayload(
                stopId: stop.stationboardStopID,
                limit: Self.boardLimit,
                includeAlerts: includeAlertsEnabled
            )
            let response = payload.response
            responseMeta = response.meta

            stationName = response.station?.name ?? stop.displayName
            departures = Self.makeDepartureDisplays(
                departures: response.departures,
                rawData: payload.rawData
            )
            servedLines = Self.extractServedLines(from: response.departures)
            lastUpdatedAt = response.meta?.serverTime ?? Date()
            freshnessLabel = Self.makeFreshnessLabel(meta: response.meta)
            errorMessage = nil
        } catch {
            errorMessage = Self.errorMessage(for: error)
        }
    }

    private static func jitteredPollNanoseconds() -> UInt64 {
        let base = Int64(pollBaseNanoseconds)
        let jitter = Int64.random(in: -Int64(pollJitterNanoseconds)...Int64(pollJitterNanoseconds))
        let result = max(1_000_000_000, base + jitter)
        return UInt64(result)
    }

    private static func makeDepartureDisplays(
        departures: [Departure],
        rawData: Data
    ) -> [DepartureDisplay] {
        let rawExcerpts = rawDepartureExcerpts(from: rawData)
        return departures.enumerated().map { index, departure in
            let fallback = departure.key ?? departure.tripID ?? "\(index)"
            return DepartureDisplay(
                id: "\(fallback)-\(index)",
                departure: departure,
                rawJSONExcerpt: index < rawExcerpts.count ? rawExcerpts[index] : nil
            )
        }
    }

    private static func rawDepartureExcerpts(from data: Data) -> [String] {
        guard
            let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let departures = json["departures"] as? [Any]
        else {
            return []
        }

        return departures.compactMap { element in
            guard JSONSerialization.isValidJSONObject(element) else { return nil }
            guard
                let encoded = try? JSONSerialization.data(withJSONObject: element, options: [.prettyPrinted]),
                let rawString = String(data: encoded, encoding: .utf8)
            else {
                return nil
            }
            let maxLength = 2000
            if rawString.count <= maxLength {
                return rawString
            }
            return String(rawString.prefix(maxLength)) + "\n..."
        }
    }

    private static func extractServedLines(from departures: [Departure]) -> [String] {
        var seen = Set<String>()
        var lines: [String] = []

        for departure in departures {
            let candidate = (departure.line ?? departure.number ?? "")
                .trimmingCharacters(in: .whitespacesAndNewlines)
            guard !candidate.isEmpty else { continue }
            if seen.insert(candidate).inserted {
                lines.append(candidate)
            }
        }

        return lines
    }

    private static func makeFreshnessLabel(meta: Meta?) -> String? {
        guard let meta else { return nil }

        var labels: [String] = []
        if let responseMode = meta.responseMode, !responseMode.isEmpty {
            labels.append("mode: \(responseMode)")
        }
        if let rtStatus = meta.rtStatus, !rtStatus.isEmpty {
            labels.append("rt: \(rtStatus)")
        }
        return labels.isEmpty ? nil : labels.joined(separator: " | ")
    }

    private static func errorMessage(for error: Error) -> String {
        if let clientError = error as? HTTPClientError {
            switch clientError {
            case .invalidURL:
                return "Invalid stationboard URL."
            case .invalidResponse:
                return "Stationboard response was invalid."
            case .unexpectedStatusCode(let code):
                return "Stationboard failed (HTTP \(code))."
            }
        }
        return "Stationboard update failed: \(error.localizedDescription)"
    }
}

private enum DateFormatters {
    static let timeFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_CH")
        formatter.timeStyle = .short
        formatter.dateStyle = .none
        return formatter
    }()

    static let dateTimeFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_CH")
        formatter.dateStyle = .medium
        formatter.timeStyle = .short
        return formatter
    }()

    static func time(_ date: Date?) -> String {
        guard let date else { return "--:--" }
        return timeFormatter.string(from: date)
    }

    static func dateTime(_ date: Date?) -> String {
        guard let date else { return "n/a" }
        return dateTimeFormatter.string(from: date)
    }
}
