import SwiftUI
import MesDepartsCore

struct ContentView: View {
    @State private var statusText = "Ready"
    @State private var isLoading = false

    var body: some View {
        NavigationStack {
            VStack(spacing: 16) {
                Text("MesDeparts")
                    .font(.title)
                    .bold()

                Text(statusText)
                    .font(.footnote)
                    .multilineTextAlignment(.center)

                Button(isLoading ? "Loading..." : "Fetch Lausanne board") {
                    Task { await fetchSampleStationboard() }
                }
                .buttonStyle(.borderedProminent)
                .disabled(isLoading)
            }
            .padding()
            .navigationTitle("MesDeparts")
        }
    }

    @MainActor
    private func fetchSampleStationboard() async {
        isLoading = true
        defer { isLoading = false }

        let api = StationboardAPI(
            baseURL: .production,
            httpClient: HTTPClient(timeout: 12)
        )

        do {
            let response = try await api.fetchStationboard(
                stopId: "Parent8501120",
                limit: 5,
                includeAlerts: true
            )
            let count = response.departures.count
            let mode = response.meta?.responseMode ?? "n/a"
            let rtStatus = response.meta?.rtStatus ?? "n/a"
            statusText = "Loaded \(count) departures (mode: \(mode), rtStatus: \(rtStatus))"
        } catch {
            statusText = "Fetch failed: \(error.localizedDescription)"
        }
    }
}
