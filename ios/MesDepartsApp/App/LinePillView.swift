import SwiftUI

struct LinePillView: View {
    let line: String

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
            .background(lineColor.opacity(0.13))
            .overlay(
                Capsule(style: .continuous)
                    .stroke(lineColor.opacity(0.45), lineWidth: 1)
            )
            .clipShape(Capsule(style: .continuous))
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Line \(line)")
    }
}
