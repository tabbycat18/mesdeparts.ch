import Foundation
import SwiftUI
import MesDepartsCore

struct FreshnessDiagnosticSample: Identifiable, Sendable {
    let id: UUID
    let requestStart: Date
    let requestEnd: Date
    let clientFetchDurationMs: Int
    let metaServerTime: Date?
    let metaRtFetchedAt: Date?
    let metaRtCacheAgeMs: Int?
    let metaRtStatus: String?
    let metaResponseMode: String?
    let stopID: String

    init(
        id: UUID = UUID(),
        requestStart: Date,
        requestEnd: Date,
        meta: Meta?,
        stopID: String
    ) {
        self.id = id
        self.requestStart = requestStart
        self.requestEnd = requestEnd
        self.clientFetchDurationMs = max(
            0,
            Int(requestEnd.timeIntervalSince(requestStart) * 1000)
        )
        self.metaServerTime = meta?.serverTime
        self.metaRtFetchedAt = meta?.rtFetchedAt
        self.metaRtCacheAgeMs = meta?.rtCacheAgeMs
        self.metaRtStatus = meta?.rtStatus
        self.metaResponseMode = meta?.responseMode
        self.stopID = stopID
    }
}

struct FreshnessDiagnosticsBuffer: Sendable {
    private(set) var samples: [FreshnessDiagnosticSample] = []
    static let maxSamples = 50

    mutating func append(_ sample: FreshnessDiagnosticSample) {
        samples.append(sample)
        if samples.count > Self.maxSamples {
            samples.removeFirst(samples.count - Self.maxSamples)
        }
    }

    var lastSample: FreshnessDiagnosticSample? {
        samples.last
    }

    var averageCadenceSeconds: Double? {
        guard samples.count > 1 else { return nil }

        var total: TimeInterval = 0
        var count = 0

        for index in 1..<samples.count {
            let delta = samples[index].requestStart.timeIntervalSince(samples[index - 1].requestStart)
            if delta > 0 {
                total += delta
                count += 1
            }
        }

        guard count > 0 else { return nil }
        return total / Double(count)
    }

    var percentRtStatusNotApplied: Double {
        guard !samples.isEmpty else { return 0 }
        let notAppliedCount = samples.reduce(into: 0) { partialResult, sample in
            let status = sample.metaRtStatus?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            if status != "applied" {
                partialResult += 1
            }
        }
        return (Double(notAppliedCount) / Double(samples.count)) * 100
    }
}

struct FreshnessDiagnosticsView: View {
    let diagnostics: FreshnessDiagnosticsBuffer
    @AppStorage(AppPreferencesKeys.language) private var languageRawValue = AppLanguageOption.en.rawValue

    private var language: AppLanguageOption {
        AppLanguageOption(rawValue: languageRawValue) ?? .en
    }

    var body: some View {
        List {
            Section("Summary") {
                DiagnosticsKeyValueRow(label: "Samples", value: String(diagnostics.samples.count))
                DiagnosticsKeyValueRow(label: "Avg cadence", value: cadenceLabel)
                DiagnosticsKeyValueRow(label: "% rtStatus != applied", value: percentLabel)
            }

            if let sample = diagnostics.lastSample {
                Section("Last sample") {
                    DiagnosticsKeyValueRow(label: "Stop ID", value: sample.stopID)
                    DiagnosticsKeyValueRow(label: "Request start", value: formatDate(sample.requestStart))
                    DiagnosticsKeyValueRow(label: "Request end", value: formatDate(sample.requestEnd))
                    DiagnosticsKeyValueRow(label: "Client fetch ms", value: String(sample.clientFetchDurationMs))
                    DiagnosticsKeyValueRow(label: "meta.serverTime", value: optionalDate(sample.metaServerTime))
                    DiagnosticsKeyValueRow(label: "meta.rtFetchedAt", value: optionalDate(sample.metaRtFetchedAt))
                    DiagnosticsKeyValueRow(label: "meta.rtCacheAgeMs", value: optionalInt(sample.metaRtCacheAgeMs))
                    DiagnosticsKeyValueRow(label: "meta.rtStatus", value: optionalString(sample.metaRtStatus))
                    DiagnosticsKeyValueRow(label: "meta.responseMode", value: optionalString(sample.metaResponseMode))
                }
            }
        }
        .navigationTitle(appLabel(.diagnostics, language: language))
    }

    private var cadenceLabel: String {
        guard let cadence = diagnostics.averageCadenceSeconds else {
            return "n/a"
        }
        return String(format: "%.1f s", cadence)
    }

    private var percentLabel: String {
        String(format: "%.1f%%", diagnostics.percentRtStatusNotApplied)
    }

    private func formatDate(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_CH")
        formatter.dateStyle = .none
        formatter.timeStyle = .medium
        return formatter.string(from: date)
    }

    private func optionalDate(_ date: Date?) -> String {
        guard let date else { return "n/a" }
        return formatDate(date)
    }

    private func optionalInt(_ value: Int?) -> String {
        guard let value else { return "n/a" }
        return String(value)
    }

    private func optionalString(_ value: String?) -> String {
        guard let value, !value.isEmpty else { return "n/a" }
        return value
    }
}

private struct DiagnosticsKeyValueRow: View {
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
