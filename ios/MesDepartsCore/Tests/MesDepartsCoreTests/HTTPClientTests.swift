import Foundation
import Testing
@testable import MesDepartsCore

struct HTTPClientTests {
    @Test
    func sendsNoStoreAndNoCacheHeaders() async throws {
        let client = HTTPClient(session: makeSession(), timeout: 8)
        let data = try await client.get(url: URL(string: "https://api.mesdeparts.ch/api/stationboard")!)
        let payload = try decodeEchoPayload(from: data)

        let cacheControl = payload["cacheControl"] as? String ?? ""
        let cachePolicy = payload["cachePolicy"] as? Int
        #expect(cacheControl.contains("no-store"))
        #expect(cacheControl.contains("no-cache"))
        #expect((payload["pragma"] as? String) == "no-cache")
        #expect(cachePolicy != nil)
        #expect((cachePolicy ?? -1) == URLRequest.CachePolicy.reloadIgnoringLocalCacheData.rawValue)
    }

    @Test
    func appliesConfiguredRequestTimeout() async throws {
        let timeout: TimeInterval = 5.5
        let client = HTTPClient(session: makeSession(), timeout: timeout)
        let data = try await client.get(url: URL(string: "https://api.mesdeparts.ch/api/stationboard")!)
        let payload = try decodeEchoPayload(from: data)

        let actual = payload["timeoutInterval"] as? Double
        #expect(actual != nil)
        #expect(abs((actual ?? 0) - timeout) < 0.01)
    }

    private func makeSession() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [EchoRequestURLProtocol.self]
        return URLSession(configuration: configuration)
    }

    private func decodeEchoPayload(from data: Data) throws -> [String: Any] {
        let object = try JSONSerialization.jsonObject(with: data)
        guard let payload = object as? [String: Any] else {
            throw HTTPClientError.invalidResponse
        }
        return payload
    }
}

private final class EchoRequestURLProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool {
        true
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest {
        request
    }

    override func startLoading() {
        let payload: [String: Any] = [
            "cacheControl": request.value(forHTTPHeaderField: "Cache-Control") ?? "",
            "pragma": request.value(forHTTPHeaderField: "Pragma") ?? "",
            "cachePolicy": request.cachePolicy.rawValue,
            "timeoutInterval": request.timeoutInterval
        ]
        let data = (try? JSONSerialization.data(withJSONObject: payload)) ?? Data("{}".utf8)
        let response = HTTPURLResponse(
            url: request.url ?? URL(string: "https://api.mesdeparts.ch/")!,
            statusCode: 200,
            httpVersion: nil,
            headerFields: ["Content-Type": "application/json"]
        )!

        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}
