import Foundation

public enum BaseURL: Equatable, Sendable {
    case production
    case staging
    case custom(URL)

    public var url: URL {
        switch self {
        case .production:
            return URL(string: "https://api.mesdeparts.ch")!
        case .staging:
            return URL(string: "https://mesdeparts-ch.fly.dev")!
        case .custom(let url):
            return url
        }
    }
}
