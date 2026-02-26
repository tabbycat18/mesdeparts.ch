import Foundation
import Testing
@testable import MesDepartsCore

struct StationboardDecodingTests {
    @Test
    func decodesAllStationboardSamplePayloads() throws {
        let folder = try payloadsFolder()
        let files = try FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)
            .filter { $0.pathExtension.lowercased() == "json" }
            .sorted { $0.lastPathComponent < $1.lastPathComponent }

        #expect(files.isEmpty == false)

        let decoder = DateParsing.makeJSONDecoder()

        for file in files {
            let data = try Data(contentsOf: file)
            let response = try decoder.decode(StationboardResponse.self, from: data)

            #expect(response.meta != nil)
            #expect(response.meta?.responseMode != nil)
            #expect(response.meta?.rtStatus != nil)
            #expect(response.meta?.serverTime != nil)

            if !response.departures.isEmpty {
                #expect(response.departures.count > 0)
            }
        }
    }

    private func payloadsFolder() throws -> URL {
        let repoRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        return repoRoot.appendingPathComponent("API/sample_payloads")
    }
}
