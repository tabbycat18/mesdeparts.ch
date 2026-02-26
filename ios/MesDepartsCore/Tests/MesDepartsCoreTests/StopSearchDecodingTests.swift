import Foundation
import Testing
@testable import MesDepartsCore

struct StopSearchDecodingTests {
    @Test
    func decodesAllStopSearchSamplePayloads() throws {
        let folder = try payloadsFolder()
        let files = try FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)
            .filter { $0.pathExtension.lowercased() == "json" }
            .sorted { $0.lastPathComponent < $1.lastPathComponent }

        #expect(files.isEmpty == false)

        let goodQueries = Set([
            "lausanne.json",
            "bel_air.json",
            "geneve_bel_air.json",
            "st_francois.json",
            "lausanne_st_francois.json"
        ])

        let decoder = JSONDecoder()

        for file in files {
            let data = try Data(contentsOf: file)
            let response = try decoder.decode(StopSearchResponse.self, from: data)

            if goodQueries.contains(file.lastPathComponent) {
                #expect(response.stops.isEmpty == false)
            }

            for result in response.stops {
                let stationboardStopId = result.stationboardStopId
                #expect(stationboardStopId != nil)
                #expect(stationboardStopId?.isEmpty == false)
            }
        }
    }

    private func payloadsFolder() throws -> URL {
        let repoRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        return repoRoot.appendingPathComponent("API/sample_payloads_stop_search")
    }
}

private struct StopSearchResponse: Decodable {
    let stops: [StopSearchResult]
}
