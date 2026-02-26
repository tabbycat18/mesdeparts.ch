import Foundation

public struct Meta: Decodable, Sendable {
    public let serverTime: Date?
    public let responseMode: String?
    public let rtStatus: String?
    public let rtFetchedAt: Date?
    public let rtCacheAgeMs: Int?
    public let rtAppliedCount: Int?
    public let totalBackendMs: Double?
}
