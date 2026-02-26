import SwiftUI

struct BlueCard<Content: View>: View {
    private let content: Content
    private let horizontalPadding: CGFloat
    private let verticalPadding: CGFloat

    init(
        horizontalPadding: CGFloat = MDDesignSystem.Spacing.md,
        verticalPadding: CGFloat = MDDesignSystem.Spacing.md,
        @ViewBuilder content: () -> Content
    ) {
        self.horizontalPadding = horizontalPadding
        self.verticalPadding = verticalPadding
        self.content = content()
    }

    var body: some View {
        content
            .padding(.horizontal, horizontalPadding)
            .padding(.vertical, verticalPadding)
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
        LinePillView(line: line)
    }
}

enum TagPillStyle {
    case onTime
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
        case .onTime:
            return WebPalette.Badge.onTimeFg
        case .delay:
            return WebPalette.Badge.delayFg
        case .cancelled:
            return Color(red: 0.72, green: 0.13, blue: 0.11)
        case .platform:
            return WebPalette.Badge.platformFg
        case .realtime:
            return WebPalette.Badge.rtFg
        }
    }

    private var backgroundColor: Color {
        switch style {
        case .onTime:
            return WebPalette.Badge.onTimeBg
        case .delay:
            return WebPalette.Badge.delayBg
        case .cancelled:
            return Color(red: 1.0, green: 0.88, blue: 0.87)
        case .platform:
            return WebPalette.Badge.platformBg
        case .realtime:
            return WebPalette.Badge.rtBg
        }
    }

    private var borderColor: Color {
        textColor.opacity(0.45)
    }
}
