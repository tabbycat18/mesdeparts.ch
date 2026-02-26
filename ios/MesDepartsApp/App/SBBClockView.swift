import SwiftUI

struct SBBClockView: View {
    private static let cycleDurationSeconds = 58.5
    private static let easingDurationMs = 2000.0

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30.0, paused: false)) { context in
            let now = context.date
            let parts = clockParts(for: now)
            let mss = Double(parts.second * 1000 + parts.millisecond)

            let secondAngle = min(
                Double(parts.second) * (360.0 / Self.cycleDurationSeconds) + Double(parts.millisecond) * 0.006,
                360.0
            )
            let minuteAngle = easeOutElastic(
                t: mss,
                b: Double(parts.minute) * 6.0 - 6.0,
                c: 6.0,
                d: Self.easingDurationMs
            )
            let hourAngle = easeOutElastic(
                t: mss,
                b: Double(parts.hour % 12) * 30.0 + Double(parts.minute) / 2.0 - 0.5,
                c: 0.5,
                d: Self.easingDurationMs
            )

            GeometryReader { geometry in
                let size = min(geometry.size.width, geometry.size.height)

                ZStack {
                    SBBClockFace()
                    SBBPolygonHand(points: [
                        CGPoint(x: 59.2, y: 68.0),
                        CGPoint(x: 52.8, y: 68.0),
                        CGPoint(x: 53.4, y: 24.0),
                        CGPoint(x: 58.6, y: 24.0)
                    ])
                    .fill(Color.black)
                    .rotationEffect(.degrees(hourAngle))

                    SBBPolygonHand(points: [
                        CGPoint(x: 58.6, y: 68.0),
                        CGPoint(x: 53.4, y: 68.0),
                        CGPoint(x: 54.2, y: 10.0),
                        CGPoint(x: 57.8, y: 10.0)
                    ])
                    .fill(Color.black)
                    .rotationEffect(.degrees(minuteAngle))

                    SBBSecondHand()
                        .fill(Color(red: 235.0 / 255.0, green: 0, blue: 0))
                        .rotationEffect(.degrees(secondAngle))
                }
                .frame(width: size, height: size)
                .position(x: geometry.size.width / 2, y: geometry.size.height / 2)
            }
            .aspectRatio(1, contentMode: .fit)
        }
        .accessibilityLabel("Analog station clock")
    }

    private func easeOutElastic(t: Double, b: Double, c: Double, d: Double) -> Double {
        let normalized = t / d
        if normalized < 1 {
            return c * pow(2, -10 * normalized) * sin((normalized * d - 2) * (2 * .pi) / 300) * 1.5 + c + b
        }
        return b + c
    }

    private func clockParts(for date: Date) -> (hour: Int, minute: Int, second: Int, millisecond: Int) {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Europe/Zurich") ?? .current
        let components = calendar.dateComponents([.hour, .minute, .second, .nanosecond], from: date)

        return (
            hour: components.hour ?? 0,
            minute: components.minute ?? 0,
            second: components.second ?? 0,
            millisecond: (components.nanosecond ?? 0) / 1_000_000
        )
    }
}

private struct SBBClockFace: View {
    var body: some View {
        GeometryReader { geometry in
            let size = min(geometry.size.width, geometry.size.height)
            let radius = size / 2.0

            ZStack {
                Circle()
                    .fill(Color.white)

                Circle()
                    .stroke(Color(red: 118.0 / 255.0, green: 118.0 / 255.0, blue: 118.0 / 255.0), lineWidth: size * 0.0135)

                ForEach(0..<60, id: \.self) { tick in
                    Rectangle()
                        .fill(Color(red: 30.0 / 255.0, green: 30.0 / 255.0, blue: 30.0 / 255.0))
                        .frame(
                            width: tick.isMultiple(of: 5) ? size * 0.03 : size * 0.012,
                            height: tick.isMultiple(of: 5) ? size * 0.11 : size * 0.03
                        )
                        .offset(y: -radius + (tick.isMultiple(of: 5) ? size * 0.11 : size * 0.07))
                        .rotationEffect(.degrees(Double(tick) * 6.0))
                }
            }
            .frame(width: size, height: size)
            .position(x: geometry.size.width / 2, y: geometry.size.height / 2)
        }
    }
}

private struct SBBPolygonHand: Shape {
    let points: [CGPoint]

    func path(in rect: CGRect) -> Path {
        guard !points.isEmpty else { return Path() }

        let scale = min(rect.width, rect.height) / 112.0
        let offsetX = rect.midX - (56.0 * scale)
        let offsetY = rect.midY - (56.0 * scale)

        func mapped(_ point: CGPoint) -> CGPoint {
            CGPoint(
                x: offsetX + point.x * scale,
                y: offsetY + point.y * scale
            )
        }

        var path = Path()
        path.move(to: mapped(points[0]))
        for point in points.dropFirst() {
            path.addLine(to: mapped(point))
        }
        path.closeSubpath()
        return path
    }
}

private struct SBBSecondHand: Shape {
    func path(in rect: CGRect) -> Path {
        let scale = min(rect.width, rect.height) / 112.0
        let offsetX = rect.midX - (56.0 * scale)
        let offsetY = rect.midY - (56.0 * scale)

        func mapX(_ x: CGFloat) -> CGFloat { offsetX + x * scale }
        func mapY(_ y: CGFloat) -> CGFloat { offsetY + y * scale }

        var path = Path()

        let circleRadius = 5.25 * scale
        let circleRect = CGRect(
            x: mapX(56.0) - circleRadius,
            y: mapY(24.8) - circleRadius,
            width: circleRadius * 2,
            height: circleRadius * 2
        )
        path.addEllipse(in: circleRect)

        let stemRect = CGRect(
            x: mapX(55.3),
            y: mapY(29.979),
            width: 1.4 * scale,
            height: (72.5 - 29.979) * scale
        )
        path.addRoundedRect(in: stemRect, cornerSize: CGSize(width: 0.7 * scale, height: 0.7 * scale))

        return path
    }
}
