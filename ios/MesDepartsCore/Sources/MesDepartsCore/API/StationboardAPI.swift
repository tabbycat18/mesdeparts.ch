import Foundation

public final class StationboardAPI: @unchecked Sendable {
    private let baseURL: URL
    private let httpClient: HTTPClient
    private let decoder: JSONDecoder

    public init(
        baseURL: BaseURL = .production,
        httpClient: HTTPClient = HTTPClient(),
        decoder: JSONDecoder = DateParsing.makeJSONDecoder()
    ) {
        self.baseURL = baseURL.url
        self.httpClient = httpClient
        self.decoder = decoder
    }

    public func fetchStationboard(
        stopId: String,
        limit: Int,
        includeAlerts: Bool
    ) async throws -> StationboardResponse {
        guard var components = URLComponents(
            url: baseURL.appendingPathComponent("api/stationboard"),
            resolvingAgainstBaseURL: false
        ) else {
            throw HTTPClientError.invalidURL
        }

        components.queryItems = [
            URLQueryItem(name: "stop_id", value: stopId),
            URLQueryItem(name: "limit", value: String(limit)),
            URLQueryItem(name: "include_alerts", value: includeAlerts ? "1" : "0")
        ]

        guard let url = components.url else {
            throw HTTPClientError.invalidURL
        }

        let data = try await httpClient.get(url: url)
        return try decoder.decode(StationboardResponse.self, from: data)
    }
}
