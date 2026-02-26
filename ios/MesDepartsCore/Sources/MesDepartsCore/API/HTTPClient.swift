import Foundation

public enum HTTPClientError: Error, Equatable {
    case invalidURL
    case invalidResponse
    case unexpectedStatusCode(Int)
}

public final class HTTPClient: @unchecked Sendable {
    private let session: URLSession
    private let timeout: TimeInterval

    public init(
        session: URLSession? = nil,
        timeout: TimeInterval = 8
    ) {
        if let session {
            self.session = session
        } else {
            let configuration = URLSessionConfiguration.ephemeral
            configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
            configuration.urlCache = nil
            self.session = URLSession(configuration: configuration)
        }
        self.timeout = timeout
    }

    public func get(url: URL) async throws -> Data {
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.timeoutInterval = timeout
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("no-store, no-cache, max-age=0", forHTTPHeaderField: "Cache-Control")
        request.setValue("no-cache", forHTTPHeaderField: "Pragma")

        let (data, response) = try await session.data(for: request)

        guard let httpResponse = response as? HTTPURLResponse else {
            throw HTTPClientError.invalidResponse
        }
        guard httpResponse.statusCode == 200 else {
            throw HTTPClientError.unexpectedStatusCode(httpResponse.statusCode)
        }

        return data
    }
}
