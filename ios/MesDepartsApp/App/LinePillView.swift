import SwiftUI

struct LinePillView: View {
    let line: String
    let isSelected: Bool

    private static let fixedWidth: CGFloat = 52
    private static let fixedHeight: CGFloat = 32

    private var lineColor: Color {
        WebPalette.lineColor(for: line)
    }

    var body: some View {
        Text(line)
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(MDDesignSystem.Colors.textPrimary)
            .lineLimit(1)
            .minimumScaleFactor(0.75)
            .frame(width: Self.fixedWidth, height: Self.fixedHeight)
            .background(lineColor.opacity(isSelected ? 0.32 : 0.13))
            .overlay(
                Capsule(style: .continuous)
                    .stroke(lineColor.opacity(isSelected ? 0.95 : 0.45), lineWidth: isSelected ? 1.8 : 1)
            )
            .clipShape(Capsule(style: .continuous))
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Line \(line)")
            .accessibilityValue(isSelected ? "Selected" : "Not selected")
    }
}
