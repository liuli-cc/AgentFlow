import Foundation

/// A provider identity is selected by the foreground application. It is never
/// inferred from a model name, which can be shared across different clients.
enum IslandAssistant: String, CaseIterable, Hashable, Sendable {
    case chatGPT
    case deepSeek
    case workBuddy
    case claude
    case codeBuddy

    var displayName: String {
        switch self {
        case .chatGPT: return "GPT"
        case .deepSeek: return "DeepSeek Harness"
        case .workBuddy: return "WorkBuddy"
        case .claude: return "Claude"
        case .codeBuddy: return "CodeBuddy"
        }
    }

    var bundleIdentifiers: [String] {
        switch self {
        case .chatGPT: return ["com.openai.codex"]
        case .deepSeek: return ["com.deepseek.dsh"]
        case .workBuddy: return ["com.workbuddy.workbuddy-ai"]
        case .claude: return ["com.anthropic.claudefordesktop"]
        case .codeBuddy: return ["com.tencent.codebuddycn"]
        }
    }

    var applicationNames: [String] {
        switch self {
        case .chatGPT: return ["ChatGPT", "Codex"]
        case .deepSeek: return ["DeepSeek Harness"]
        case .workBuddy: return ["WorkBuddy AI", "WorkBuddy"]
        case .claude: return ["Claude"]
        case .codeBuddy: return ["CodeBuddy CN", "CodeBuddy"]
        }
    }

    var symbolName: String {
        switch self {
        case .chatGPT: return "waveform.path"
        case .deepSeek: return "sparkle"
        case .workBuddy: return "briefcase"
        case .claude: return "sun.max"
        case .codeBuddy: return "chevron.left.forwardslash.chevron.right"
        }
    }

    /// Colors sampled from installed application icons. GPT retains the user's
    /// requested violet palette; text colors are lifted for contrast on black.
    var palette: AssistantPalette {
        switch self {
        case .chatGPT: return .init(accent: .init(0.76, 0.57, 1), start: .init(0.66, 0.45, 1), end: .init(0.95, 0.65, 0.96))
        case .deepSeek: return .init(accent: .init(0.49, 0.64, 1), start: .init(0.36, 0.62, 1), end: .init(0.73, 0.53, 1))
        case .workBuddy: return .init(accent: .init(0.29, 0.84, 0.75), start: .init(0.18, 0.78, 0.74), end: .init(0.53, 0.90, 0.78))
        case .claude: return .init(accent: .init(0.93, 0.61, 0.46), start: .init(0.86, 0.49, 0.36), end: .init(0.97, 0.73, 0.58))
        case .codeBuddy: return .init(accent: .init(0.69, 0.61, 1), start: .init(0.58, 0.46, 1), end: .init(0.39, 0.79, 0.86))
        }
    }

    static func matching(bundleIdentifier: String?, bundlePath: String?, localizedName: String?) -> Self? {
        if let bundleIdentifier,
           let exact = allCases.first(where: { $0.bundleIdentifiers.contains(bundleIdentifier) }) { return exact }
        // An unrelated main bundle must not match just because its app filename
        // is similar. In particular, standalone ChatGPT has separate telemetry
        // from the installed com.openai.codex client.
        if let bundleIdentifier {
            guard let helperOwner = allCases.first(where: { provider in
                provider.bundleIdentifiers.contains { bundleIdentifier.hasPrefix($0 + ".") }
            }) else { return nil }
            if let bundlePath,
               URL(fileURLWithPath: bundlePath).pathComponents.contains(where: {
                   $0.hasSuffix(".app") && helperOwner.applicationNames.contains(String($0.dropLast(4)))
               }) {
                return helperOwner
            }
            return nil
        }
        // Main app bundles and their internal helpers are accepted; unrelated
        // processes with a similar title are not allowed to change the island.
        if let bundlePath {
            let components = URL(fileURLWithPath: bundlePath).pathComponents
            if let app = components.first(where: { $0.hasSuffix(".app") }) {
                let name = String(app.dropLast(4))
                return allCases.first(where: { $0.applicationNames.contains(name) })
            }
        }
        guard bundleIdentifier == nil, bundlePath == nil, let localizedName else { return nil }
        return allCases.first(where: { $0.applicationNames.contains(localizedName) })
    }

    static func selected(frontmost: Self?, previous: Self, running: Set<Self>) -> Self? {
        if let frontmost, running.contains(frontmost) { return frontmost }
        if running.contains(previous) { return previous }
        return allCases.first(where: running.contains)
    }

    static func completionSource(_ source: String) -> Self? {
        switch source {
        case "Codex", "CC Switch": return .chatGPT
        case "DeepSeek Harness": return .deepSeek
        case "WorkBuddy": return .workBuddy
        case "Claude", "Claude Code": return .claude
        case "CodeBuddy": return .codeBuddy
        default: return nil
        }
    }
}

struct AssistantPalette: Equatable, Sendable {
    struct RGB: Equatable, Sendable {
        let red: Double
        let green: Double
        let blue: Double
        init(_ red: Double, _ green: Double, _ blue: Double) {
            self.red = red; self.green = green; self.blue = blue
        }
    }
    let accent: RGB
    let start: RGB
    let end: RGB
}
