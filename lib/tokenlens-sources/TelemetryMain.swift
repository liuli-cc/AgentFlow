import Foundation
import CryptoKit

// Uses the installed TokenLens readers, with a metadata-only stdout boundary.
// This executable never receives a prompt and never writes to assistant data.
@main struct TelemetryMain {
    static func modelMetadata(_ value: String) -> String? {
        let text = value.trimmingCharacters(in: .whitespacesAndNewlines)
        let unknown = ["未知模型", "模型未返回", "等待 Codex", "等待 Harness"]
        guard !text.isEmpty, text.count <= 200, !unknown.contains(text),
              !text.lowercased().hasPrefix("sk-"), !text.lowercased().contains("bearer "),
              text.unicodeScalars.allSatisfy({ CharacterSet.letters.contains($0) || CharacterSet.decimalDigits.contains($0) || " ._:/()+#@-".unicodeScalars.contains($0) }) else { return nil }
        return text
    }

    static func observedModels(_ snapshot: UsageSnapshot, id: String) -> [[String: Any]] {
        snapshot.observedTodayModels.compactMap { row -> [String: Any]? in
            guard let model = modelMetadata(row.model) else { return nil }
            let route = modelMetadata(row.provider)
            let modelID = ["dsh", "codex"].contains(id) ? "\(route ?? "unknown")::\(model)" : model
            return ["id": modelID, "label": id == "dsh" ? "\(route ?? "unknown") · \(model)" : model,
                "providerRoute": route ?? "unknown", "window": "today",
                "usage": ["input": row.usage.inputTokens, "output": row.usage.outputTokens,
                    "cacheRead": row.cacheKnown ? row.usage.cachedInputTokens as Any : NSNull(),
                    "cacheWrite": NSNull(), "reasoning": NSNull(), "costUSD": NSNull(),
                    "source": "当日本机日志中归属于此模型的样本"]]
        }.sorted { ($0["id"] as? String ?? "") < ($1["id"] as? String ?? "") }.prefix(64).map { $0 }
    }

    static func recentCalls(_ snapshot: UsageSnapshot, id: String) -> [[String: Any]] {
        snapshot.recentUsageCalls.compactMap { row -> [String: Any]? in
            guard let model = modelMetadata(row.model) else { return nil }
            let route = modelMetadata(row.provider) ?? "unknown"
            let identity = SHA256.hash(data: Data("\(id)|\(row.id)".utf8)).map { String(format: "%02x", $0) }.joined()
            return ["id": identity, "providerId": id,
                "modelId": ["dsh", "codex"].contains(id) ? "\(route)::\(model)" : model,
                "modelLabel": id == "dsh" ? "\(route) · \(model)" : model,
                "time": ISO8601DateFormatter().string(from: row.at), "scope": "software",
                "source": "本机日志样本",
                "usage": ["input": row.usage.inputTokens, "output": row.usage.outputTokens,
                    "cacheRead": row.cacheKnown ? row.usage.cachedInputTokens as Any : NSNull(),
                    "cacheWrite": row.cacheWriteKnown ? row.usage.cacheWriteInputTokens as Any : NSNull(),
                    "reasoning": row.reasoningKnown ? row.usage.reasoningOutputTokens as Any : NSNull(),
                    "costUSD": NSNull()]]
        }
    }

    static func main() async {
        let now = Date()
        let missingDB = URL(fileURLWithPath: "/nonexistent-agentflow-no-provider-balance.db")
        let scanner = CodexLogScanner(ccSwitchScanner: CCSwitchScanner(databaseURL: missingDB))
        async let codex = try? scanner.scan(now: now, historyDays: 7)
        async let additional = AdditionalAssistantReader().read(now: now)
        let dsh = await DeepSeekActivityReader().read(now: now).usageSnapshot
        let others = await additional
        let first = await codex ?? .empty
        let entries: [(String, String, UsageSnapshot)] = [
            ("codex", "GPT / Codex", first),
            ("claude", "Claude Desktop", others[.claude] ?? .empty),
            ("workbuddy", "WorkBuddy", others[.workBuddy] ?? .empty),
            ("codebuddy", "CodeBuddy", others[.codeBuddy] ?? .empty),
            ("dsh", "DeepSeek Harness", dsh)
        ]
        let providers: [[String: Any]] = entries.map { id, name, s in
            let u = s.todayUsage
            func known(_ value: Int64, _ isKnown: Bool) -> Any { isKnown ? value : NSNull() }
            return ["id": id, "name": name, "scope": "software", "partial": true,
                "models": observedModels(s, id: id),
                "usage": ["input": known(u.inputTokens, s.tokenUsageKnown),
                    "output": known(u.outputTokens, s.tokenUsageKnown),
                    "cacheRead": known(u.cachedInputTokens, s.cacheUsageKnown),
                    "cacheWrite": NSNull(), "reasoning": NSNull(), "costUSD": NSNull(),
                    "source": "TokenLens 本地读取器 · 当日限量日志样本，不是本任务用量"]]
        }
        let result: [String: Any] = ["schemaVersion": 1, "updatedAt": ISO8601DateFormatter().string(from: now),
            "providers": providers, "recentCalls": entries.flatMap { recentCalls($0.2, id: $0.0) },
            "sourceRevision": "946ad5239fa17c26fccd593393b70777fd801559+agentflow-calls"]
        if let data = try? JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]) {
            FileHandle.standardOutput.write(data)
        }
    }
}
