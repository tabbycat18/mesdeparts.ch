import SwiftUI

struct BlueCard<Content: View>: View {
    @ViewBuilder let content: Content

    var body: some View {
        content
            .padding(MDDesignSystem.Spacing.md)
            .background(MDDesignSystem.Colors.card)
            .overlay(
                RoundedRectangle(cornerRadius: MDDesignSystem.Radius.card, style: .continuous)
                    .stroke(MDDesignSystem.Colors.stroke, lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: MDDesignSystem.Radius.card, style: .continuous))
            .shadow(color: MDDesignSystem.Colors.accent.opacity(0.08), radius: 8, x: 0, y: 3)
    }
}

struct SectionHeader: View {
    let title: String
    let subtitle: String?

    init(title: String, subtitle: String? = nil) {
        self.title = title
        self.subtitle = subtitle
    }

    var body: some View {
        VStack(alignment: .leading, spacing: MDDesignSystem.Spacing.xxs) {
            Text(title)
                .font(.headline)
                .foregroundStyle(MDDesignSystem.Colors.textPrimary)
            if let subtitle, !subtitle.isEmpty {
                Text(subtitle)
                    .font(.footnote)
                    .foregroundStyle(MDDesignSystem.Colors.textSecondary)
            }
        }
        .accessibilityElement(children: .combine)
    }
}

struct LinePill: View {
    let line: String

    var body: some View {
        HStack(spacing: MDDesignSystem.Spacing.xs) {
            Circle()
                .fill(RouteColorPalette.color(for: line))
                .frame(width: 10, height: 10)

            Text(line)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(MDDesignSystem.Colors.textPrimary)
                .lineLimit(1)
        }
        .padding(.horizontal, MDDesignSystem.Spacing.sm)
        .padding(.vertical, MDDesignSystem.Spacing.xs)
        .background(RouteColorPalette.color(for: line).opacity(0.13))
        .overlay(
            Capsule(style: .continuous)
                .stroke(RouteColorPalette.color(for: line).opacity(0.45), lineWidth: 1)
        )
        .clipShape(Capsule(style: .continuous))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Line \(line)")
    }
}

enum TagPillStyle {
    case delay
    case cancelled
    case platform
    case realtime
}

struct TagPill: View {
    let text: String
    let style: TagPillStyle

    var body: some View {
        Text(text)
            .font(.caption.weight(.semibold))
            .padding(.horizontal, MDDesignSystem.Spacing.xs)
            .padding(.vertical, MDDesignSystem.Spacing.xxs)
            .foregroundStyle(textColor)
            .background(backgroundColor)
            .overlay(
                Capsule(style: .continuous)
                    .stroke(borderColor, lineWidth: 1)
            )
            .clipShape(Capsule(style: .continuous))
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(text)
    }

    private var textColor: Color {
        switch style {
        case .delay:
            return Color(red: 0.74, green: 0.30, blue: 0.05)
        case .cancelled:
            return Color(red: 0.72, green: 0.13, blue: 0.11)
        case .platform:
            return MDDesignSystem.Colors.accent
        case .realtime:
            return Color(red: 0.12, green: 0.50, blue: 0.23)
        }
    }

    private var backgroundColor: Color {
        switch style {
        case .delay:
            return Color(red: 1.0, green: 0.92, blue: 0.83)
        case .cancelled:
            return Color(red: 1.0, green: 0.88, blue: 0.87)
        case .platform:
            return MDDesignSystem.Colors.accent.opacity(0.12)
        case .realtime:
            return Color(red: 0.87, green: 0.96, blue: 0.89)
        }
    }

    private var borderColor: Color {
        textColor.opacity(0.45)
    }
}

enum RouteColorPalette {
    private static let palette: [Color] = [
        Color(red: 0.07, green: 0.42, blue: 0.86),
        Color(red: 0.17, green: 0.55, blue: 0.32),
        Color(red: 0.90, green: 0.42, blue: 0.13),
        Color(red: 0.74, green: 0.31, blue: 0.77),
        Color(red: 0.15, green: 0.61, blue: 0.74),
        Color(red: 0.69, green: 0.18, blue: 0.31)
    ]

    static func color(for line: String) -> Color {
        let normalized = line.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !normalized.isEmpty else {
            return MDDesignSystem.Colors.accent
        }

        var hash = 0
        for scalar in normalized.unicodeScalars {
            hash = (hash * 31 + Int(scalar.value))
        }
        let index = abs(hash) % palette.count
        return palette[index]
    }
}
