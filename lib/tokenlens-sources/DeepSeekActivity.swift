import Foundation

struct DeepSeekActivitySnapshot: Equatable, Sendable {
    var isRunning = false
    var latestCompletion: TaskCompletionNotice?
    var completionEvents: [TaskCompletionNotice] = []
    var usageSnapshot: UsageSnapshot = .empty
}

/// Only explicit `turn/end` with reason `completed` is a completion. In
/// particular, cancellation, error, blocked, file writes and balance changes
/// must never produce the completion feedback.
struct DeepSeekEventDigest: Sendable {
    var sessionID = ""
    var isUserSession = false
    var activeTurn: Int?
    var startedAt: Date?
    var latestCompletion: TaskCompletionNotice?
    var completionEvents: [TaskCompletionNotice] = []
    var model = "等待 Harness"
    var provider = "DeepSeek"
    var contextWindow: Int64 = 0
    var usage: TokenUsage = .zero
    var lastUsage: TokenUsage = .zero
    var usageKnown = false
    var cacheKnown = false
    var latestUsageAt: Date?
    var latestEventAt: Date?
    private var cacheComplete = true
    var samples: [DeepSeekUsageSample] = []
    private var usageIDs = Set<String>()
    private var seedEnded = false
    private var turnStartUsage: TokenUsage = .zero
    private var turnUsageKnown = false

    mutating func consume(_ line: Data) {
        guard let envelope = try? JSONDecoder().decode(Envelope.self, from: line) else { return }
        if envelope.type == "session" {
            sessionID = envelope.id ?? ""
            isUserSession = envelope.version == 4 && envelope.delegationDepth == 0
            // Fresh headless v4 sessions have no end-seed marker at all. Only
            // explicitly seeded transcripts wait for that marker to avoid replay.
            seedEnded = envelope.isSeeded == false
            return
        }
        guard isUserSession else { return }
        latestEventAt = envelope.time.map { Date(timeIntervalSince1970: $0 / 1000) } ?? latestEventAt
        if envelope.type == "session/end-seed" { seedEnded = true; return }
        // Only whitelisted metadata is retained; message content and tool output are discarded.
        if ["model/selection", "request/header", "request/context", "assistant/message", "assistant/attempt"].contains(envelope.type),
           let raw = try? JSONSerialization.jsonObject(with: line) as? [String: Any],
           let data = raw["data"] as? [String: Any] {
            if envelope.type == "model/selection" { select(data) }
            if envelope.type == "request/header", let header = data["header"] as? [String: Any],
               let config = header["config"] as? [String: Any] { select(config) }
            if envelope.type == "request/context" {
                select(data)
                if let window = number(data["contextWindow"]), window > 0 { contextWindow = window }
            }
            if seedEnded && (envelope.type == "assistant/message" || envelope.type == "assistant/attempt") {
                var rawUsage = data["usage"] as? [String: Any]
                if rawUsage == nil, let stream = data["stream"] as? [[String: Any]] {
                    rawUsage = stream.last(where: { $0["type"] as? String == "usage" })?["usage"] as? [String: Any]
                }
                if let rawUsage, let input = number(rawUsage["inputTokens"]), let output = number(rawUsage["outputTokens"]) {
                    let read = number(rawUsage["cacheReadTokens"]) ?? 0
                    let write = number(rawUsage["cacheWriteTokens"]) ?? 0
                    let knownTotal = input + read + write + output
                    let exactTotal: Int64
                    if let total = number(rawUsage["totalTokens"]) {
                        guard total >= knownTotal else { return }
                        if rawUsage["cacheReadTokens"] != nil && rawUsage["cacheWriteTokens"] != nil && total != knownTotal { return }
                        exactTotal = total
                    } else {
                        guard rawUsage["cacheReadTokens"] != nil && rawUsage["cacheWriteTokens"] != nil else { return }
                        exactTotal = knownTotal
                    }
                    let reasoning = number(rawUsage["reasoningTokens"]) ?? 0
                    guard reasoning <= output else { return }
                    let measured = TokenUsage(inputTokens: exactTotal - output, cachedInputTokens: read,
                        outputTokens: output, reasoningOutputTokens: reasoning,
                        totalTokens: exactTotal, cacheWriteInputTokens: write)
                    let id = "\(sessionID)|\(raw["seq"] ?? raw["time"] ?? "unknown")"
                    if usageIDs.insert(id).inserted {
                        if let source = (data["message"] as? [String: Any])?["source"] as? [String: Any] { select(source) }
                        usage = usage + measured; lastUsage = measured; usageKnown = true; turnUsageKnown = true
                        cacheComplete = cacheComplete && rawUsage["cacheReadTokens"] != nil
                        cacheKnown = cacheComplete
                        latestUsageAt = envelope.time.map { Date(timeIntervalSince1970: $0 / 1000) }
                        if let at = latestUsageAt { samples.append(DeepSeekUsageSample(id: id, at: at, usage: measured, model: model, provider: provider, cacheKnown: rawUsage["cacheReadTokens"] != nil, cacheWriteKnown: rawUsage["cacheWriteTokens"] != nil, reasoningKnown: rawUsage["reasoningTokens"] != nil)) }
                    }
                }
            }
        }
        guard let turn = envelope.data?.turn else { return }
        let time = envelope.time.map { Date(timeIntervalSince1970: $0 / 1000) }
        if envelope.type == "turn/start" {
            activeTurn = turn
            startedAt = time
            turnStartUsage = usage
            turnUsageKnown = false
        } else if envelope.type == "turn/end" {
            defer { if activeTurn == turn { activeTurn = nil; startedAt = nil } }
            guard envelope.data?.reason?.kind == "completed", let time, !sessionID.isEmpty else { return }
            let identity = "dsh|\(sessionID)|\(turn)"
            guard !completionEvents.contains(where: { $0.id == identity }) else { return }
            latestCompletion = TaskCompletionNotice(
                id: identity, sessionID: sessionID, turnID: String(turn),
                title: "DeepSeek 已完成本轮任务", provider: "DeepSeek", model: "DeepSeek Harness",
                source: "DeepSeek Harness", usage: usage - turnStartUsage, quotaUsedPercent: nil, costUSD: nil,
                startedAt: startedAt ?? time, completedAt: time, usageKnown: turnUsageKnown
            )
            if let completion = latestCompletion,
               !completionEvents.contains(where: { $0.id == completion.id }) {
                completionEvents.append(completion)
                let newest = completionEvents.map(\.completedAt).max() ?? time
                completionEvents = CompletionEventBatch.recent(completionEvents, now: newest)
            }
        }
    }

    private mutating func select(_ raw: [String: Any]) {
        if let value = raw["model"] as? String, !value.isEmpty {
            if model != value { contextWindow = 0 }
            model = value
        }
        if let value = raw["provider"] as? String, !value.isEmpty { provider = value }
    }
    private func number(_ value: Any?) -> Int64? {
        guard let value = value as? NSNumber, value.doubleValue.isFinite, value.doubleValue >= 0 else { return nil }
        return value.int64Value
    }

    private struct Envelope: Decodable {
        let type: String
        let id: String?
        let version: Int?
        let delegationDepth: Int?
        let isSeeded: Bool?
        let time: Double?
        let data: EventData?
    }
    private struct EventData: Decodable {
        let turn: Int?
        let reason: Reason?
    }
    private struct Reason: Decodable { let kind: String }
}

struct DeepSeekUsageSample: Sendable {
    let id: String
    let at: Date
    let usage: TokenUsage
    let model: String
    let provider: String
    let cacheKnown: Bool
    var cacheWriteKnown = false
    var reasoningKnown = false
}

actor DeepSeekActivityReader {
    private let root: URL
    private var cache: [URL: Entry] = [:]
    private struct Entry { let modified: Date; let size: Int; let digest: DeepSeekEventDigest }

    init(root: URL = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".dsh/sessions")) {
        self.root = root
    }

    func read(now: Date = Date()) -> DeepSeekActivitySnapshot {
        let keys: Set<URLResourceKey> = [.contentModificationDateKey, .fileSizeKey, .isRegularFileKey]
        guard let enumerator = FileManager.default.enumerator(at: root, includingPropertiesForKeys: Array(keys), options: [.skipsHiddenFiles]) else { return .init() }
        var candidates: [(url: URL, modified: Date, size: Int)] = []
        var nodesVisited = 0
        for case let url as URL in enumerator {
            nodesVisited += 1
            if nodesVisited > 5000 { break }
            if (try? url.resourceValues(forKeys: [.isSymbolicLinkKey]).isSymbolicLink) == true { enumerator.skipDescendants(); continue }
            guard url.lastPathComponent == "session.v4.jsonl.zstd" else { continue }
            guard let values = try? url.resourceValues(forKeys: keys), values.isRegularFile == true,
                  let modified = values.contentModificationDate, let size = values.fileSize,
                  now.timeIntervalSince(modified) < 8 * 86_400,
                  size < 64 * 1_024 * 1_024 else { continue }
            candidates.append((url, modified, size))
        }
        let recent = candidates.sorted { $0.modified > $1.modified }.prefix(64)
        let seen = Set(recent.map(\.url))
        var decoded = 0
        for item in recent {
            if cache[item.url]?.modified == item.modified && cache[item.url]?.size == item.size { continue }
            guard decoded < 4 else { continue }
            decoded += 1
            if let digest = Self.decompress(item.url) {
                cache[item.url] = Entry(modified: item.modified, size: item.size, digest: digest)
            }
        }
        cache = cache.filter { seen.contains($0.key) }
        return DeepSeekActivitySnapshot(
            isRunning: cache.values.contains { $0.digest.activeTurn != nil && now.timeIntervalSince($0.modified) < 600 },
            latestCompletion: cache.values.compactMap(\.digest.latestCompletion).max { $0.completedAt < $1.completedAt },
            completionEvents: CompletionEventBatch.recent(cache.values.flatMap(\.digest.completionEvents), now: now),
            usageSnapshot: makeSnapshot(now: now)
        )
    }

    private func makeSnapshot(now: Date) -> UsageSnapshot {
        let digests = cache.values.map(\.digest).filter(\.isUserSession)
        let active = digests.max { ($0.latestEventAt ?? .distantPast) < ($1.latestEventAt ?? .distantPast) }
        let calendar = Calendar.current
        let today = calendar.startOfDay(for: now)
        let start = calendar.date(byAdding: .day, value: -6, to: today) ?? today
        var todayModels: [String: ObservedModelUsage] = [:]
        var recentCalls: [ObservedUsageCall] = []
        var seen = Set<String>(), totals: [Date: TokenUsage] = [:], models: [String: TokenUsage] = [:], requests: [String: Int] = [:]
        for sample in digests.flatMap(\.samples) where sample.at >= start && sample.at <= now {
            guard seen.insert(sample.id).inserted else { continue }
            recentCalls.append(ObservedUsageCall(id: sample.id, at: sample.at, provider: sample.provider,
                model: sample.model, usage: sample.usage, cacheKnown: sample.cacheKnown,
                cacheWriteKnown: sample.cacheWriteKnown, reasoningKnown: sample.reasoningKnown))
            let day = calendar.startOfDay(for: sample.at)
            totals[day, default: .zero] = totals[day, default: .zero] + sample.usage
            models[sample.model, default: .zero] = models[sample.model, default: .zero] + sample.usage
            requests[sample.model, default: 0] += 1
            if day == today {
                let identity = "\(sample.provider)::\(sample.model)"
                let prior = todayModels[identity]
                todayModels[identity] = ObservedModelUsage(provider: sample.provider, model: sample.model,
                    usage: (prior?.usage ?? .zero) + sample.usage, cacheKnown: (prior?.cacheKnown ?? true) && sample.cacheKnown)
            }
        }
        return UsageSnapshot(currentModel: active?.model ?? "等待 Harness", currentProvider: active?.provider ?? "DeepSeek",
            currentSource: "DeepSeek Harness", currentSessionUsage: active?.usage ?? .zero,
            lastCallUsage: active?.lastUsage ?? .zero, contextWindow: active?.contextWindow ?? 0,
            dailyUsage: (0..<7).compactMap { offset in calendar.date(byAdding: .day, value: offset, to: start).map { DayUsage(date: $0, usage: totals[$0] ?? .zero) } },
            modelUsage: models.map { ModelUsage(provider: "DeepSeek Harness", model: $0.key, tokens: $0.value.totalTokens,
                requests: requests[$0.key] ?? 0, source: "DeepSeek Harness", requestsKnown: true) }.sorted { $0.tokens > $1.tokens },
            observedTodayModels: Array(todayModels.values),
            recentUsageCalls: Array(recentCalls.sorted { $0.at > $1.at }.prefix(96)),
            lastEventAt: active?.latestUsageAt, filesObserved: cache.count,
            tokenUsageKnown: active?.usageKnown ?? false, cacheUsageKnown: active?.cacheKnown ?? false,
            contextUsedTokens: active?.usageKnown == true ? active?.lastUsage.totalTokens : nil,
            contextIsEstimate: true, metricsSource: "Harness v4 · 适配器返回的 usage",
            metricsDiagnostic: "最近7天本机根会话；未返回 usage 的尝试无法计入 Token。缓存命中分母含缓存创建，推理 Token 已包含在输出。上下文按最近响应总量估算，后续工具消息和压缩变化可能未反映。",
            metricsUpdatedAt: active?.latestUsageAt, recentRequestCount: active?.usageKnown == true ? seen.count : nil)
    }

    private static func decompress(_ url: URL) -> DeepSeekEventDigest? {
        let bundled = Bundle.main.bundleURL.appendingPathComponent("Contents/Helpers/zstd").path
        let candidates = [bundled, "/opt/homebrew/bin/zstd", "/usr/local/bin/zstd", "/usr/bin/zstd"]
        guard let executable = candidates.first(where: { FileManager.default.isExecutableFile(atPath: $0) }) else { return nil }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = ["-dcq", url.path]
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        guard (try? process.run()) != nil else { return nil }
        var digest = DeepSeekEventDigest()
        var pending = Data()
        var bytesRead = 0
        while let data = try? pipe.fileHandleForReading.read(upToCount: 65_536), !data.isEmpty {
            bytesRead += data.count
            // Malformed or unexpectedly large logs never stall a UI refresh.
            if bytesRead > 128 * 1_024 * 1_024 { process.terminate(); break }
            pending.append(data)
            while let end = pending.firstIndex(of: 10) {
                let line = pending.prefix(upTo: end)
                // Decode only lifecycle envelopes, never message text or tool output.
                if line.range(of: Data("\"turn/start\"".utf8)) != nil ||
                    line.range(of: Data("\"turn/end\"".utf8)) != nil ||
                    line.range(of: Data("\"session\"".utf8)) != nil ||
                    line.range(of: Data("\"session/end-seed\"".utf8)) != nil ||
                    line.range(of: Data("\"assistant/message\"".utf8)) != nil ||
                    line.range(of: Data("\"assistant/attempt\"".utf8)) != nil ||
                    line.range(of: Data("\"request/context\"".utf8)) != nil ||
                    line.range(of: Data("\"request/header\"".utf8)) != nil ||
                    line.range(of: Data("\"model/selection\"".utf8)) != nil {
                    digest.consume(Data(line))
                }
                pending.removeSubrange(...end)
            }
        }
        process.waitUntilExit()
        // Concurrent appends can leave an incomplete zstd frame; retry next poll.
        guard process.terminationStatus == 0 else { return nil }
        return digest
    }
}
