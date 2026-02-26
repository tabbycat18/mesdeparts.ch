import Foundation

public struct StopSearchResult: Decodable, Sendable {
    public let id: String?
    public let name: String?
    public let stopID: String?
    public let stationID: String?
    public let stationName: String?
    public let groupID: String?
    public let rawStopID: String?
    public let stopName: String?
    public let parentStation: String?
    public let locationType: String?
    public let numberOfStopTimes: Int?
    public let city: String?
    public let canton: String?
    public let isParent: Bool?
    public let isPlatform: Bool?
    public let aliasesMatched: [String]?

    public var stationboardStopId: String? {
        for candidate in [stationID, groupID, stopID, id, rawStopID, parentStation] {
            guard let value = candidate?.trimmingCharacters(in: .whitespacesAndNewlines) else {
                continue
            }
            if !value.isEmpty {
                return value
            }
        }
        return nil
    }

    enum CodingKeys: String, CodingKey {
        case id
        case name
        case stopID = "stop_id"
        case stationID = "stationId"
        case stationName
        case groupID = "group_id"
        case rawStopID = "raw_stop_id"
        case stopName = "stop_name"
        case parentStation = "parent_station"
        case locationType = "location_type"
        case numberOfStopTimes = "nb_stop_times"
        case city
        case canton
        case isParent
        case isPlatform
        case aliasesMatched
    }
}
