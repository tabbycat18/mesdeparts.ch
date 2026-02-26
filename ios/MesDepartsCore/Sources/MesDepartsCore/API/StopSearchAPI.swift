import Foundation

public final class StopSearchAPI: @unchecked Sendable {
    private let baseURL: URL
    private let httpClient: HTTPClient
    private let decoder: JSONDecoder

    public init(
        baseURL: BaseURL = .production,
        httpClient: HTTPClient = HTTPClient(),
        decoder: JSONDecoder = JSONDecoder()
    ) {
        self.baseURL = baseURL.url
        self.httpClient = httpClient
        self.decoder = decoder
    }

    public func searchStops(
        query: String,
        limit: Int
    ) async throws -> [StopSearchResult] {
        guard var components = URLComponents(
            url: baseURL.appendingPathComponent("api/stops/search"),
            resolvingAgainstBaseURL: false
        ) else {
            throw HTTPClientError.invalidURL
        }

        components.queryItems = [
            URLQueryItem(name: "q", value: query),
            URLQueryItem(name: "limit", value: String(limit))
        ]

        guard let url = components.url else {
            throw HTTPClientError.invalidURL
        }

        let data = try await httpClient.get(url: url)
        let response = try decoder.decode(StopSearchResponse.self, from: data)
        return response.stops
    }
}

private struct StopSearchResponse: Decodable {
    let stops: [StopSearchResult]
}
