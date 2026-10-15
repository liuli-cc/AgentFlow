import Foundation
import CoreFoundation

// This reader retains usage metadata only. Transcript bodies, credentials,
// account identifiers and prompts never enter its digest or UI snapshot.
actor AdditionalAssistantReader {
    private let home: URL
    private let appSupport: URL
    private var cache: [String: CachedFile] = [:]
    private var remainingReadBudget = 64 * 1024 * 1024

    init(home: URL = FileManager.default.homeDirectoryForCurrentUser, appSupport: URL? = nil) {
        self.home = home
        self.appSupport = appSupport ?? home.appendingPathComponent("Library/Application Support")
    }

    func read(now: Date = Date()) async -> [IslandAssistant: UsageSnapshot] {
        remainingReadBudget = 64 * 1024 * 1024
        let after = now.addingTimeInterval(-8 * 86_400)
        let workFiles = files(in: home.appendingPathComponent(".workbuddy-ai/projects"), after: after, kind: .workBuddy)
        let codeFiles = files(in: appSupport.appendingPathComponent("CodeBuddyExtension/Data"), after: after, kind: .codeBuddy)
        let claudeFiles = ["local-agent-mode-sessions", "claude-code-sessions"].flatMap {
            files(in: appSupport.appendingPathComponent("Claude/\($0)"), after: after, kind: .claude)
        }
        let workRecords = records(in: workFiles, kind: .workBuddy)
        var work = summarize(workRecords, source: "WorkBuddy", now: now, files: workFiles.count, countsRequests: true)
        applyWorkBuddyContext(to: &work, session: latest(workRecords, now: now)?.session, now: now)
        let code = summarize(records(in: codeFiles, kind: .codeBuddy), source: "CodeBuddy", now: now, files: codeFiles.count, countsRequests: false)
        var claude = summarize(records(in: claudeFiles, kind: .claude), source: "Claude Desktop / Cowork", now: now, files: claudeFiles.count, countsRequests: true)
        if !claude.tokenUsageKnown {
            claude.metricsDiagnostic = "Claude 桌面聊天/Cowork 未返回令牌指标；Claude Code 记录独立，不计入此岛"
        }
        if let data = try? Data(contentsOf: appSupport.appendingPathComponent("Claude/plan-usage-history.json")),
           let document = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let quota = Self.claudeQuota(document, now: now) {
            claude.quota = quota.primary
            claude.secondaryQuota = quota.secondary
            claude.quotaUpdatedAt = quota.at
            claude.metricsDiagnostic = claude.tokenUsageKnown
                ? "本机 Desktop/Cowork 响应用量；额度为 Claude 本机服务端采样，余额未返回"
                : "Claude Desktop/Cowork 令牌未返回；额度为 Claude 本机服务端采样；独立 Code 记录未计入"
        }
        // Prune parsed digests when files disappear; do not retain chat content.
        let live = Set((workFiles + codeFiles + claudeFiles).map { $0.url.path })
        cache = cache.filter { live.contains($0.key) }
        return [.workBuddy: work, .claude: claude, .codeBuddy: code]
    }

    struct Record: Sendable {
        let id: String
        let session: String
        let at: Date
        let usage: TokenUsage
        let cacheKnown: Bool
        let model: String?
        let requests: Int?
        var primary = true
        var running = false
        var cacheWriteKnown = false
        var reasoningKnown = false
    }
    private struct FileInfo {
        let url: URL
        let modified: Date
        let size: Int
    }
    private struct CachedFile {
        let modified: Date
        let size: Int
        let records: [Record]
    }

    static func nonnegativeInteger(_ value: Any?) -> Int64? {
        // NSNumber also represents JSON booleans; those are not token counts.
        guard let n = value as? NSNumber,
              CFGetTypeID(n) != CFBooleanGetTypeID(),
              n.doubleValue.isFinite, n.doubleValue >= 0,
              n.doubleValue <= 9_007_199_254_740_991,
              n.doubleValue.rounded(.towardZero) == n.doubleValue else { return nil }
        return n.int64Value
    }

    static func date(_ value: Any?) -> Date? {
        if let n = value as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(), n.doubleValue.isFinite, n.doubleValue > 1e12 {
            return Date(timeIntervalSince1970: n.doubleValue / 1000)
        }
        guard let text = value as? String else { return nil }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: text) ?? ISO8601DateFormatter().date(from: text)
    }

    static func model(_ value: Any?) -> String? {
        guard let text = value as? String, !text.isEmpty, text.count <= 96,
              text.unicodeScalars.allSatisfy({ CharacterSet.letters.contains($0) || CharacterSet.decimalDigits.contains($0) || " ._:/()+-".unicodeScalars.contains($0) }) else { return nil }
        return text
    }

    static func workBuddyRecord(_ event: [String: Any]) -> Record? {
        guard let provider = event["providerData"] as? [String: Any],
              let raw = provider["usage"] as? [String: Any],
              let id = provider["messageId"] as? String, !id.isEmpty,
              let at = date(event["timestamp"]),
              let input = nonnegativeInteger(raw["inputTokens"]),
              let output = nonnegativeInteger(raw["outputTokens"]),
              let total = nonnegativeInteger(raw["totalTokens"]),
              input <= Int64.max - output, total == input + output else { return nil }
        let original = provider["rawUsage"] as? [String: Any] ?? [:]
        let read = nonnegativeInteger(original["prompt_cache_hit_tokens"])
            ?? nonnegativeInteger(original["cached_tokens"])
            ?? nonnegativeInteger(original["cache_read_input_tokens"])
        let write = nonnegativeInteger(original["prompt_cache_write_tokens"])
            ?? nonnegativeInteger(original["cache_creation_input_tokens"])
        let reasoning = nonnegativeInteger(original["completion_thinking_tokens"])
        let cacheKnown = read != nil && read! <= input
        let usage = TokenUsage(inputTokens: input, cachedInputTokens: cacheKnown ? read! : 0,
            outputTokens: output, reasoningOutputTokens: reasoning != nil && reasoning! <= output ? reasoning! : 0, totalTokens: total,
            cacheWriteInputTokens: write != nil && write! <= input ? write! : 0)
        return Record(id: id, session: event["sessionId"] as? String ?? "", at: at, usage: usage,
            cacheKnown: cacheKnown,
            model: model(provider["requestModelId"]) ?? model(provider["model"]) ?? model(provider["requestModelName"]),
            requests: nonnegativeInteger(raw["requests"]).flatMap { Int(exactly: $0) },
            primary: provider["isSubAgent"] as? Bool != true,
            cacheWriteKnown: write != nil && write! <= input,
            reasoningKnown: reasoning != nil && reasoning! <= output)
    }

    // Native Desktop/Cowork and Claude Code use this message shape. The reader
    // deliberately scans only Desktop-owned roots, never ~/.claude/projects.
    static func claudeRecord(_ event: [String: Any]) -> Record? {
        guard event["type"] as? String == "assistant",
              let message = event["message"] as? [String: Any],
              let raw = message["usage"] as? [String: Any],
              let id = message["id"] as? String, !id.isEmpty,
              let at = date(event["timestamp"]),
              let uncached = nonnegativeInteger(raw["input_tokens"]),
              let output = nonnegativeInteger(raw["output_tokens"]) else { return nil }
        let read = nonnegativeInteger(raw["cache_read_input_tokens"])
        let write = nonnegativeInteger(raw["cache_creation_input_tokens"])
        // Anthropic input_tokens excludes reads/writes, unlike OpenAI's prompt.
        let (inputPartial, overflow1) = uncached.addingReportingOverflow(read ?? 0)
        let (input, overflow2) = inputPartial.addingReportingOverflow(write ?? 0)
        let (total, overflow3) = input.addingReportingOverflow(output)
        guard !overflow1 && !overflow2 && !overflow3 else { return nil }
        let known = read != nil && write != nil
        return Record(id: id, session: event["sessionId"] as? String ?? "", at: at,
            usage: TokenUsage(inputTokens: input, cachedInputTokens: known ? read! : 0,
                outputTokens: output, totalTokens: total, cacheWriteInputTokens: known ? write! : 0),
            cacheKnown: known, model: model(message["model"]), requests: 1,
            primary: event["isSidechain"] as? Bool != true, cacheWriteKnown: known)
    }

    static func codeBuddyRecords(_ document: [String: Any], session: String) -> [Record] {
        guard let requests = document["requests"] as? [[String: Any]] else { return [] }
        return requests.compactMap { request in
            guard let raw = request["usage"] as? [String: Any],
                  let id = request["id"] as? String, !id.isEmpty,
                  let at = date(request["startedAt"]),
                  let input = nonnegativeInteger(raw["inputTokens"]),
                  let output = nonnegativeInteger(raw["outputTokens"]),
                  let total = nonnegativeInteger(raw["totalTokens"]),
                  input <= Int64.max - output, total == input + output else { return nil }
            let read = nonnegativeInteger(raw["cacheTokens"])
            let write = nonnegativeInteger(raw["cachedWriteTokens"])
            let known = read != nil && read! <= input
            // credit measures consumption, not funds remaining. lastTokens has
            // no verified context-capacity contract and is not a percentage.
            return Record(id: id, session: session, at: at,
                usage: TokenUsage(inputTokens: input, cachedInputTokens: known ? read! : 0,
                    outputTokens: output, totalTokens: total,
                    cacheWriteInputTokens: write != nil && write! <= input ? write! : 0),
                cacheKnown: known, model: nil, requests: nil,
                running: request["state"] as? String == "running", cacheWriteKnown: write != nil && write! <= input)
        }
    }

    static func deduplicate(_ records: [Record]) -> [Record] {
        var unique: [String: Record] = [:]
        for record in records {
            if let old = unique[record.id],
               old.usage.totalTokens > record.usage.totalTokens || old.usage.totalTokens == record.usage.totalTokens && old.at > record.at { continue }
            unique[record.id] = record
        }
        return Array(unique.values)
    }

    private func latest(_ records: [Record], now: Date) -> Record? {
        let current = records.filter { $0.at <= now.addingTimeInterval(300) && $0.at >= now.addingTimeInterval(-8 * 86_400) }
        return (current.filter(\.primary).max { $0.at < $1.at }) ?? current.max { $0.at < $1.at }
    }

    private func summarize(_ records: [Record], source: String, now: Date, files: Int, countsRequests: Bool) -> UsageSnapshot {
        var snapshot = UsageSnapshot()
        snapshot.currentModel = "模型未返回"
        snapshot.currentProvider = source
        snapshot.currentSource = source
        snapshot.metricsSource = source
        snapshot.metricsDiagnostic = "本机未返回可识别的用量；额度与余额不可读取"
        snapshot.contextIsEstimate = false
        snapshot.filesObserved = files
        let rows = Self.deduplicate(records).filter { $0.at <= now.addingTimeInterval(300) && $0.at >= now.addingTimeInterval(-8 * 86_400) }
        guard let current = latest(rows, now: now) else { return snapshot }
        let session = rows.filter { $0.session == current.session }
        snapshot.currentModel = current.model ?? "模型未返回"
        snapshot.currentSessionUsage = session.reduce(.zero) { $0 + $1.usage }
        snapshot.lastCallUsage = current.usage
        snapshot.tokenUsageKnown = true
        snapshot.cacheUsageKnown = session.allSatisfy(\.cacheKnown)
        snapshot.lastEventAt = current.at
        snapshot.metricsUpdatedAt = current.at
        let recent = rows.filter { $0.at >= now.addingTimeInterval(-86_400) }
        if countsRequests, recent.allSatisfy({ $0.requests != nil }) {
            snapshot.recentRequestCount = recent.reduce(0) { $0 + ($1.requests ?? 0) }
        }
        let calendar = Calendar.current
        let today = calendar.startOfDay(for: now)
        snapshot.dailyUsage = (0..<7).compactMap { index in
            guard let date = calendar.date(byAdding: .day, value: index - 6, to: today),
                  let end = calendar.date(byAdding: .day, value: 1, to: date) else { return nil }
            return DayUsage(date: date, usage: rows.filter { $0.at >= date && $0.at < end }.reduce(.zero) { $0 + $1.usage })
        }
        snapshot.sessionsToday = Set(rows.filter { calendar.isDate($0.at, inSameDayAs: now) }.map(\.session)).count
        let modelStart = calendar.date(byAdding: .day, value: -6, to: today) ?? today
        let byModel = Dictionary(grouping: rows.filter { $0.at >= modelStart }, by: { $0.model ?? "模型未返回" })
        snapshot.modelUsage = byModel.map { name, records in
            ModelUsage(provider: source, model: name, tokens: records.reduce(0) { $0 + $1.usage.totalTokens },
                requests: records.reduce(0) { $0 + ($1.requests ?? 0) }, source: source,
                requestsKnown: countsRequests && records.allSatisfy { $0.requests != nil })
        }.sorted { $0.tokens > $1.tokens }
        let todayByModel = Dictionary(grouping: rows.filter {
            calendar.isDate($0.at, inSameDayAs: now) && $0.model != nil
        }, by: { $0.model! })
        snapshot.observedTodayModels = todayByModel.map { model, records in
            ObservedModelUsage(provider: source, model: model,
                usage: records.reduce(.zero) { $0 + $1.usage }, cacheKnown: records.allSatisfy(\.cacheKnown))
        }
        snapshot.recentUsageCalls = rows.filter { $0.model != nil && $0.at <= now }
            .sorted { $0.at > $1.at }.prefix(96).map {
                ObservedUsageCall(id: $0.id, at: $0.at, provider: source, model: $0.model!,
                    usage: $0.usage, cacheKnown: $0.cacheKnown, cacheWriteKnown: $0.cacheWriteKnown,
                    reasoningKnown: $0.reasoningKnown)
            }
        snapshot.isTaskRunning = rows.contains { $0.running && now.timeIntervalSince($0.at) < 600 }
        snapshot.metricsDiagnostic = source == "CodeBuddy"
            ? "本机历史按用户请求去重；API 调用次数、上下文容量、剩余额度与余额未返回"
            : "本机响应 usage；只覆盖留存在本机的记录，额度与余额未返回"
        return snapshot
    }

    private func files(in root: URL, after: Date, kind: IslandAssistant) -> [FileInfo] {
        let keys: [URLResourceKey] = [.isRegularFileKey, .isDirectoryKey, .isSymbolicLinkKey, .contentModificationDateKey, .fileSizeKey]
        guard let iterator = FileManager.default.enumerator(at: root, includingPropertiesForKeys: keys,
            options: [.skipsHiddenFiles], errorHandler: { _, _ in true }) else { return [] }
        var found: [FileInfo] = []
        var visited = 0
        for case let url as URL in iterator {
            visited += 1
            if visited > 5_000 { break }
            guard let properties = try? url.resourceValues(forKeys: Set(keys)) else { continue }
            if properties.isSymbolicLink == true || ["node_modules", "plugins", "memory", "vm.bundle", "blobs"].contains(url.lastPathComponent) {
                iterator.skipDescendants(); continue
            }
            guard properties.isRegularFile == true,
                  let modified = properties.contentModificationDate, modified >= after,
                  let size = properties.fileSize, size <= 64 * 1024 * 1024 else { continue }
            let recognized = kind == .codeBuddy
                ? url.pathExtension == "json" && url.pathComponents.contains("history")
                : url.pathExtension == "jsonl"
            if recognized { found.append(FileInfo(url: url, modified: modified, size: size)) }
        }
        return Array(found.sorted { $0.modified > $1.modified }.prefix(128))
    }

    private func records(in files: [FileInfo], kind: IslandAssistant) -> [Record] {
        files.flatMap { file in
            guard file.size <= remainingReadBudget else { return [Record]() }
            remainingReadBudget -= file.size
            if let old = cache[file.url.path], old.modified == file.modified, old.size == file.size { return old.records }
            var records: [Record] = []
            if let data = try? Data(contentsOf: file.url) {
                if kind == .codeBuddy {
                    if let document = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                        records = Self.codeBuddyRecords(document, session: file.url.deletingLastPathComponent().path)
                    }
                } else if let text = String(data: data, encoding: .utf8) {
                    for line in text.split(separator: "\n", omittingEmptySubsequences: true) where line.utf8.count <= 2 * 1024 * 1024 {
                        guard let document = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any] else { continue }
                        if let record = kind == .workBuddy ? Self.workBuddyRecord(document) : Self.claudeRecord(document) { records.append(record) }
                    }
                }
            }
            cache[file.url.path] = CachedFile(modified: file.modified, size: file.size, records: records)
            return records
        }
    }

    private func applyWorkBuddyContext(to snapshot: inout UsageSnapshot, session: String?, now: Date) {
        let database = home.appendingPathComponent(".workbuddy-ai/workbuddy.db")
        guard FileManager.default.fileExists(atPath: database.path),
              FileManager.default.isExecutableFile(atPath: "/usr/bin/sqlite3") else { return }
        let lowerActivity = Int64(now.addingTimeInterval(-600).timeIntervalSince1970 * 1000)
        let upperActivity = Int64(now.addingTimeInterval(5).timeIntervalSince1970 * 1000)
        if let activity = sqliteRows(database: database, statement:
            "SELECT COUNT(*) AS active FROM sessions WHERE status IN ('working','planning') AND COALESCE(is_background_automation,0)=0 AND (deleted_at IS NULL OR deleted_at<0) AND last_activity_at BETWEEN \(lowerActivity) AND \(upperActivity)")?.first {
            snapshot.isTaskRunning = (Self.nonnegativeInteger(activity["active"]) ?? 0) > 0
            snapshot.metricsDiagnostic = (snapshot.metricsDiagnostic ?? "") + "；运行状态取自本机会话，未提供任务结束时间"
        }
        let whereClause = session.map { "WHERE session_id='\($0.replacingOccurrences(of: "'", with: "''"))'" } ?? ""
        guard let row = sqliteRows(database: database, statement:
            "SELECT used,size,updated_at FROM session_usage \(whereClause) ORDER BY updated_at DESC LIMIT 1")?.first,
              let used = Self.nonnegativeInteger(row["used"]),
              let size = Self.nonnegativeInteger(row["size"]), size > 0, used <= size,
              let at = Self.date(row["updated_at"]), at <= now.addingTimeInterval(300) else { return }
        snapshot.contextUsedTokens = used
        snapshot.contextWindow = size
        snapshot.contextIsEstimate = false
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "zh_CN")
        formatter.dateFormat = "M月d日 HH:mm"
        snapshot.metricsDiagnostic = (snapshot.metricsDiagnostic ?? "") + "；上下文取自 session_usage.used/size（\(formatter.string(from: at))）"
    }

    private func sqliteRows(database: URL, statement: String) -> [[String: Any]]? {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/sqlite3")
        process.arguments = ["-readonly", "-json", database.path, statement]
        let output = Pipe()
        process.standardOutput = output
        process.standardError = FileHandle.nullDevice
        guard (try? process.run()) != nil else { return nil }
        let data = output.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else { return nil }
        return try? JSONSerialization.jsonObject(with: data) as? [[String: Any]]
    }

    struct ClaudeQuota {
        let primary: RateLimitWindow
        let secondary: RateLimitWindow?
        let at: Date
    }
    static func claudeQuota(_ document: [String: Any], now: Date) -> ClaudeQuota? {
        guard let samples = document["samples"] as? [[String: Any]] else { return nil }
        for sample in samples.sorted(by: { (date($0["t"]) ?? .distantPast) > (date($1["t"]) ?? .distantPast) }) {
            guard let at = date(sample["t"]), at <= now.addingTimeInterval(5), now.timeIntervalSince(at) <= 900,
                  let usage = sample["u"] as? [String: Any] else { continue }
            func window(_ value: Any?, minutes: Int) -> RateLimitWindow? {
                guard let raw = value as? [String: Any], let number = raw["utilization"] as? NSNumber,
                      CFGetTypeID(number) != CFBooleanGetTypeID(), number.doubleValue.isFinite,
                      (0...100).contains(number.doubleValue),
                      let reset = date(raw["resets_at"]), reset > now else { return nil }
                return RateLimitWindow(usedPercent: number.doubleValue, windowMinutes: minutes, resetsAt: reset, planType: nil)
            }
            let primary = window(usage["five_hour"], minutes: 300)
            let secondary = window(usage["seven_day"], minutes: 10_080)
            if let first = primary ?? secondary { return ClaudeQuota(primary: first, secondary: primary == nil ? nil : secondary, at: at) }
        }
        return nil
    }
}
