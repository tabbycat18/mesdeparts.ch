import SwiftUI
import UIKit

enum MDDesignSystem {
    enum Colors {
        static let background = Color(
            uiColor: UIColor { trait in
                trait.userInterfaceStyle == .dark
                    ? UIColor(red: 0.05, green: 0.09, blue: 0.16, alpha: 1)
                    : UIColor(red: 0.94, green: 0.97, blue: 1.0, alpha: 1)
            }
        )

        static let card = Color(
            uiColor: UIColor { trait in
                trait.userInterfaceStyle == .dark
                    ? UIColor(red: 0.10, green: 0.15, blue: 0.24, alpha: 1)
                    : UIColor.white
            }
        )

        static let stroke = Color(
            uiColor: UIColor { trait in
                trait.userInterfaceStyle == .dark
                    ? UIColor(red: 0.20, green: 0.35, blue: 0.64, alpha: 0.9)
                    : UIColor(red: 0.72, green: 0.84, blue: 0.98, alpha: 1)
            }
        )

        static let textPrimary = Color.primary
        static let textSecondary = Color.secondary
        static let accent = Color(red: 0.07, green: 0.42, blue: 0.86)
    }

    enum Spacing {
        static let xxs: CGFloat = 4
        static let xs: CGFloat = 8
        static let sm: CGFloat = 12
        static let md: CGFloat = 16
        static let lg: CGFloat = 20
        static let xl: CGFloat = 24
    }

    enum Radius {
        static let card: CGFloat = 16
        static let pill: CGFloat = 999
    }
}
