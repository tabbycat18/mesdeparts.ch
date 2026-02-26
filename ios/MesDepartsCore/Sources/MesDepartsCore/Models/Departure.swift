import Foundation

public struct Departure: Decodable, Sendable {
    public let key: String?
    public let tripID: String?
    public let routeID: String?
    public let stopID: String?
    public let stopSequence: Int?

    public let line: String?
    public let category: String?
    public let number: String?
    public let destination: String?

    public let scheduledDeparture: Date?
    public let realtimeDeparture: Date?
    public let delayMin: Int?

    public let platform: String?
    public let platformChanged: Bool?
    public let previousPlatform: String?

    public let cancelled: Bool
    public let status: String?
    public let cancelReasonCode: String?
    public let replacementType: String?
    public let flags: [String]?

    enum CodingKeys: String, CodingKey {
        case key
        case tripID = "trip_id"
        case routeID = "route_id"
        case stopID = "stop_id"
        case stopSequence = "stop_sequence"
        case line
        case category
        case number
        case destination
        case scheduledDeparture
        case realtimeDeparture
        case delayMin
        case platform
        case platformChanged
        case previousPlatform
        case cancelled
        case status
        case cancelReasonCode
        case replacementType
        case flags
    }
}
