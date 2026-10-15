import Foundation

struct TokenUsage: Equatable, Sendable {
    var inputTokens: Int64 = 0
    var cachedInputTokens: Int64 = 0
    var outputTokens: Int64 = 0
    var reasoningOutputTokens: Int64 = 0
    var totalTokens: Int64 = 0
    var cacheWriteInputTokens: Int64 = 0

    static let zero = TokenUsage()

    static func - (lhs: TokenUsage, rhs: TokenUsage) -> TokenUsage {
        TokenUsage(
            inputTokens: max(0, lhs.inputTokens - rhs.inputTokens),
            cachedInputTokens: max(0, lhs.cachedInputTokens - rhs.cachedInputTokens),
            outputTokens: max(0, lhs.outputTokens - rhs.outputTokens),
            reasoningOutputTokens: max(0, lhs.reasoningOutputTokens - rhs.reasoningOutputTokens),
            totalTokens: max(0, lhs.totalTokens - rhs.totalTokens),
            cacheWriteInputTokens: max(0, lhs.cacheWriteInputTokens - rhs.cacheWriteInputTokens)
        )
    }

    static func + (lhs: TokenUsage, rhs: TokenUsage) -> TokenUsage {
        TokenUsage(
            inputTokens: lhs.inputTokens + rhs.inputTokens,
            cachedInputTokens: lhs.cachedInputTokens + rhs.cachedInputTokens,
            outputTokens: lhs.outputTokens + rhs.outputTokens,
            reasoningOutputTokens: lhs.reasoningOutputTokens + rhs.reasoningOutputTokens,
            totalTokens: lhs.totalTokens + rhs.totalTokens,
            cacheWriteInputTokens: lhs.cacheWriteInputTokens + rhs.cacheWriteInputTokens
        )
    }
}

struct RateLimitWindow: Equatable, Sendable {
    var usedPercent: Double
    var windowMinutes: Int
    var resetsAt: Date?
    var planType: String?

    var remainingPercent: Double {
        min(100, max(0, 100 - usedPercent))
    }
}

struct ProviderBalance: Equatable, Sendable {
    struct Amount: Equatable, Sendable {
        let currency: String
        let value: Double

        var displayValue: String {
            let magnitude = abs(value)
            let digits = magnitude > 0 && magnitude < 0.01 ? min(8, max(4, Int(ceil(-log10(magnitude))) + 1)) : 2
            let valueText = magnitude > 0 && magnitude < 0.00000001 ? (value < 0 ? ">-0.00000001" : "<0.00000001") : String(format: "%.*f", digits, value)
            switch currency.uppercased() {
            case "CNY", "RMB": return "¥\(valueText)"
            case "USD": return "$\(valueText)"
            default: return "\(currency.uppercased()) \(valueText)"
            }
        }
    }

    let amounts: [Amount]
    let fetchedAt: Date

    var displayValue: String {
        amounts.map(\.displayValue).joined(separator: " / ")
    }
}

struct TaskCompletionNotice: Identifiable, Equatable, Sendable {
    let id: String
    let sessionID: String
    let turnID: String
    let title: String
    let provider: String
    let model: String
    let source: String
    let usage: TokenUsage
    let quotaUsedPercent: Double?
    let costUSD: Double?
    let startedAt: Date
    let completedAt: Date
    var usageKnown = true

    var usageDisplayValue: String { usageKnown ? usage.totalTokens.compactTokenString : "--" }
    var isDeepSeek: Bool { source == "DeepSeek Harness" }

    var usesExternalModel: Bool {
        source == "CC Switch"
    }

    var secondaryMetricTitle: String {
        usesExternalModel ? "费用约" : "额度消耗"
    }

    var secondaryMetricValue: String {
        if usesExternalModel {
            guard let costUSD else { return "未返回" }
            if costUSD > 0, costUSD < 0.0001 {
                return "<$0.0001"
            }
            let digits = costUSD < 1 ? 4 : 2
            return String(format: "$%.*f", digits, costUSD)
        }
        guard let quotaUsedPercent else { return "未返回" }
        if quotaUsedPercent == 0 { return "<1%" }
        return quotaUsedPercent.oneDecimalPercent
    }
}

enum QuotaDeltaCalculator {
    static func delta(
        startUsedPercent: Double?,
        startResetAt: Date?,
        endUsedPercent: Double?,
        endResetAt: Date?
    ) -> Double? {
        guard let startUsedPercent,
              let startResetAt,
              let endUsedPercent,
              let endResetAt,
              startResetAt == endResetAt,
              endUsedPercent >= startUsedPercent else { return nil }
        return endUsedPercent - startUsedPercent
    }
}

struct CompletionNoticeGate: Sendable {
    private(set) var hasSeeded = false
    private(set) var lastCompletionID: String?

    mutating func nextNotice(
        from completion: TaskCompletionNotice?,
        now: Date = Date(),
        freshness: TimeInterval = 90
    ) -> TaskCompletionNotice? {
        guard hasSeeded else {
            hasSeeded = true
            lastCompletionID = completion?.id
            return nil
        }

        guard let completion,
              completion.id != lastCompletionID else { return nil }
        lastCompletionID = completion.id

        let age = now.timeIntervalSince(completion.completedAt)
        guard age >= -5, age <= freshness else { return nil }
        return completion
    }
}

enum CompletionEventBatch {
    static let maximumCount = 128
    static let freshness: TimeInterval = 90

    /// Stable chronological metadata batches, including concurrent sessions.
    /// No chat content or inferred success state is added here.
    static func recent(_ completions: [TaskCompletionNotice], now: Date,
                       freshness: TimeInterval = CompletionEventBatch.freshness) -> [TaskCompletionNotice] {
        var unique: [String: TaskCompletionNotice] = [:]
        for completion in completions {
            let age = now.timeIntervalSince(completion.completedAt)
            guard age >= -5, age <= freshness else { continue }
            unique[completion.source + "|" + completion.id] = completion
        }
        let sorted = unique.values.sorted {
            if $0.completedAt != $1.completedAt { return $0.completedAt < $1.completedAt }
            return $0.id < $1.id
        }
        return Array(sorted.suffix(maximumCount))
    }
}

struct DayUsage: Identifiable, Equatable, Sendable {
    let date: Date
    let usage: TokenUsage

    var id: Date { date }
}

struct ModelUsage: Identifiable, Equatable, Sendable {
    let provider: String
    let model: String
    let tokens: Int64
    let requests: Int
    let source: String
    var requestsKnown: Bool = false

    var id: String { "\(source)|\(provider)|\(model)" }
}

struct ConfiguredModel: Identifiable, Equatable, Sendable {
    let provider: String
    let model: String
    let displayName: String
    let contextWindow: Int64
    let isCurrentProvider: Bool

    var id: String { "\(provider)|\(model)" }
}

// One local-day subtotal attributed by actual response metadata, never a catalog.
struct ObservedModelUsage: Equatable, Sendable {
    let provider: String
    let model: String
    let usage: TokenUsage
    var cacheKnown = false
}

// A timestamped usage event, never interpolated from a daily subtotal.
struct ObservedUsageCall: Equatable, Sendable {
    let id: String
    let at: Date
    let provider: String
    let model: String
    let usage: TokenUsage
    var cacheKnown = false
    var cacheWriteKnown = false
    var reasoningKnown = false
}

struct UsageSnapshot: Equatable, Sendable {
    var currentModel: String = "等待 Codex"
    var currentProvider: String = "OpenAI"
    var currentSource: String = "Codex"
    var currentSessionUsage: TokenUsage = .zero
    var lastCallUsage: TokenUsage = .zero
    var contextWindow: Int64 = 0
    var quota: RateLimitWindow?
    var providerBalance: ProviderBalance?
    var providerRechargeURL: URL?
    var dailyUsage: [DayUsage] = []
    var modelUsage: [ModelUsage] = []
    var observedTodayModels: [ObservedModelUsage] = []
    var recentUsageCalls: [ObservedUsageCall] = []
    var configuredModels: [ConfiguredModel] = []
    var sessionsToday: Int = 0
    var lastEventAt: Date?
    var filesObserved: Int = 0
    var latestCompletion: TaskCompletionNotice? = nil
    var completionEvents: [TaskCompletionNotice] = []
    var isTaskRunning = false
    // Missing metadata is deliberately distinct from a measured zero.
    var tokenUsageKnown = false
    var cacheUsageKnown = false
    var contextUsedTokens: Int64? = nil
    var contextIsEstimate = true
    var metricsSource = "未读取"
    var metricsDiagnostic: String? = nil
    var metricsUpdatedAt: Date? = nil
    var recentRequestCount: Int? = nil
    var secondaryQuota: RateLimitWindow? = nil
    var quotaUpdatedAt: Date? = nil
    var quotaLimitID: String? = nil
    var quotaLimitName: String? = nil
    var requestCountIsLowerBound = true

    var cacheHitPercent: Double? {
        guard cacheUsageKnown, currentSessionUsage.inputTokens > 0 else { return nil }
        return min(100, max(0, Double(currentSessionUsage.cachedInputTokens) / Double(currentSessionUsage.inputTokens) * 100))
    }

    var contextPercent: Double? {
        guard let contextUsedTokens, contextWindow > 0 else { return nil }
        return min(100, max(0, Double(contextUsedTokens) / Double(contextWindow) * 100))
    }

    var cacheHitDisplayValue: String { cacheHitPercent?.oneDecimalPercent ?? "--" }
    var contextDisplayValue: String {
        guard let contextPercent else { return "--" }
        return (contextIsEstimate ? "≈" : "") + contextPercent.oneDecimalPercent
    }

    /// Account quota is a sampled server report, never a token-derived estimate.
    /// A reset that has already passed cannot imply the account has 100% left.
    func effectiveQuota(now: Date = Date()) -> RateLimitWindow? {
        guard let sampledAt = quotaUpdatedAt, now.timeIntervalSince(sampledAt) >= -5,
              now.timeIntervalSince(sampledAt) <= 900 else { return nil }
        return [quota, secondaryQuota].compactMap { $0 }
            .filter { $0.resetsAt.map { $0 > now } ?? false }
            .min { $0.remainingPercent < $1.remainingPercent }
    }
    var quotaDisplayValue: String { effectiveQuota()?.remainingPercent.oneDecimalPercent ?? "--" }
    var tokenDisplayValue: String { tokenUsageKnown ? todayUsage.totalTokens.compactTokenString : "--" }

    static let empty = UsageSnapshot()

    var cacheHitRate: Double {
        cacheHitPercent ?? 0
    }

    var contextUsedPercent: Double {
        contextPercent ?? 0
    }

    var todayUsage: TokenUsage {
        dailyUsage.last?.usage ?? .zero
    }

    var usesExternalModel: Bool {
        currentSource == "CC Switch" || currentSource == "Codex 外部模型"
    }

    var quotaMetricTitle: String {
        usesExternalModel ? "余额" : "剩余额度"
    }

    var sharedQuotaMetricTitle: String {
        usesExternalModel ? "官方余额" : "共享额度剩余"
    }

    var balanceDisplayValue: String {
        providerBalance?.displayValue ?? "不可读取"
    }
}

extension Int64 {
    var compactTokenString: String {
        let value = Double(self)
        if value >= 1_000_000 {
            return Self.format(value / 1_000_000, suffix: "M")
        }
        if value >= 1_000 {
            return Self.format(value / 1_000, suffix: "K")
        }
        return "\(self)"
    }

    private static func format(_ value: Double, suffix: String) -> String {
        let digits = value >= 100 ? 0 : (value >= 10 ? 1 : 2)
        return String(format: "%.*f%@", digits, value, suffix)
    }
}

extension Double {
    var oneDecimalPercent: String {
        String(format: "%.1f%%", self)
    }
}
