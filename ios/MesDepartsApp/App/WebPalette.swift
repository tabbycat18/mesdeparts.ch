import SwiftUI

enum WebPalette {
    enum Brand {
        static let boardBlue = Color(hex: "#01157F")
    }

    enum Badge {
        // Web board has no dedicated on-time/RT badge classes; statuses are mostly text color.
        static let onTimeBg = Color.clear
        static let onTimeFg = Color(hex: "#FFFFFF")

        static let delayBg = Color.clear
        static let delayFg = Color(hex: "#FEE401")

        static let rtBg = Color.clear
        static let rtFg = Color(hex: "#FFFFFF")

        static let platformBg = Color.clear
        static let platformFg = Color(hex: "#FFFFFF")
    }

    enum Line {
        // Mirrors realtime_api/frontend/config/network-map.json classPrefix metadata.
        static let networkClassPrefixes: [String: String] = [
            "tpg": "line-tpg-",
            "tl": "line-tl-",
            "zvv": "line-zvv-",
            "tpn": "line-tpn-",
            "mbc": "line-mbc-",
            "vmcv": "line-vmcv-",
            "postauto": "line-postbus",
        ]

        // Mirrors .line-generic-tone-0...23 from v20260227.style.css.
        private static let genericTones: [Color] = [
            Color(hex: "#1F6FEB"),
            Color(hex: "#B42318"),
            Color(hex: "#0B7A75"),
            Color(hex: "#7A3DB8"),
            Color(hex: "#A85E00"),
            Color(hex: "#005F99"),
            Color(hex: "#2E7D32"),
            Color(hex: "#8A2C5F"),
            Color(hex: "#C0392B"),
            Color(hex: "#00796B"),
            Color(hex: "#5D4037"),
            Color(hex: "#3949AB"),
            Color(hex: "#9C27B0"),
            Color(hex: "#2F855A"),
            Color(hex: "#1565C0"),
            Color(hex: "#AD1457"),
            Color(hex: "#C75A00"),
            Color(hex: "#6A1B9A"),
            Color(hex: "#00695C"),
            Color(hex: "#8D6E00"),
            Color(hex: "#37474F"),
            Color(hex: "#C2185B"),
            Color(hex: "#0277BD"),
            Color(hex: "#558B2F"),
        ]

        static func color(for lineId: String) -> Color {
            let normalized = lineId.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
            guard !normalized.isEmpty else { return genericTones[0] }

            var hash: UInt32 = 0
            for scalar in normalized.unicodeScalars {
                hash = (hash &* 33) &+ UInt32(scalar.value)
            }
            let index = Int(hash % UInt32(genericTones.count))
            return genericTones[index]
        }
    }

    // iOS departure model currently provides `line` but not `operatorKey`.
    static func lineColor(for lineId: String) -> Color {
        Line.color(for: lineId)
    }
}

private extension Color {
    init(hex: String) {
        let value = hex.trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: "#", with: "")
        guard value.count == 6, let intValue = Int(value, radix: 16) else {
            self = .clear
            return
        }
        let red = Double((intValue >> 16) & 0xFF) / 255.0
        let green = Double((intValue >> 8) & 0xFF) / 255.0
        let blue = Double(intValue & 0xFF) / 255.0
        self = Color(red: red, green: green, blue: blue)
    }
}
