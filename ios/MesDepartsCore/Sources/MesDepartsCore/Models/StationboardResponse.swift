import Foundation

public struct StationboardResponse: Decodable, Sendable {
    public let station: Station?
    public let resolved: Resolved?
    public let departures: [Departure]
    public let meta: Meta?

    public struct Station: Decodable, Sendable {
        public let id: String?
        public let name: String?
    }

    public struct Resolved: Decodable, Sendable {
        public let canonicalId: String?
        public let source: String?
        public let childrenCount: Int?
    }
}
