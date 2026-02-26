import SwiftUI

struct BoardHeaderView: View {
    let stationName: String
    let subtitle: String?
    let updatedAt: Date?
    let freshnessLabel: String?
    let updatedLabel: String

    var body: some View {
        BlueCard {
            VStack(alignment: .leading, spacing: MDDesignSystem.Spacing.sm) {
                HStack(alignment: .top, spacing: MDDesignSystem.Spacing.md) {
                    SBBClockView()
                        .frame(width: 84, height: 84)

                    VStack(alignment: .leading, spacing: MDDesignSystem.Spacing.xxs) {
                        Text(stationName)
                            .font(.title2.weight(.semibold))
                            .foregroundStyle(MDDesignSystem.Colors.textPrimary)
                            .lineLimit(2)

                        if let subtitle, !subtitle.isEmpty {
                            Text(subtitle)
                                .font(.footnote)
                                .foregroundStyle(MDDesignSystem.Colors.textSecondary)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }

                if let updatedAt {
                    Text("\(updatedLabel): \(Self.timeFormatter.string(from: updatedAt))")
                        .font(.footnote)
                        .foregroundStyle(MDDesignSystem.Colors.textSecondary)
                        .monospacedDigit()
                }

                if let freshnessLabel, !freshnessLabel.isEmpty {
                    Text(freshnessLabel)
                        .font(.caption)
                        .foregroundStyle(MDDesignSystem.Colors.textSecondary)
                }
            }
            .accessibilityElement(children: .combine)
        }
    }

    private static let timeFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_CH")
        formatter.timeStyle = .short
        formatter.dateStyle = .none
        return formatter
    }()
}
