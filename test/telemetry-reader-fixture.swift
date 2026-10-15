import Foundation

// Runs only against the caller-owned synthetic directory; never the user's logs.
@main struct TelemetryReaderFixture {
    static func line(_ value: [String: Any]) -> Data { try! JSONSerialization.data(withJSONObject: value) }
    static func rows(_ values: [ObservedModelUsage]) -> [[String: Any]] {
        values.map { ["provider": $0.provider, "model": $0.model, "input": $0.usage.inputTokens,
            "output": $0.usage.outputTokens, "cacheRead": $0.cacheKnown ? $0.usage.cachedInputTokens as Any : NSNull()] }
    }
    static func main() async throws {
        let root = URL(fileURLWithPath: CommandLine.arguments[1])
        let now = Date(timeIntervalSince1970: Double(CommandLine.arguments[2])!)
        let missingDB = root.appendingPathComponent("missing.db")
        let scanner = CodexLogScanner(sessionsRoot: root.appendingPathComponent("sessions"),
            ccSwitchScanner: CCSwitchScanner(databaseURL: missingDB), threadTitleStore: CodexThreadTitleStore(codexRoot: root))
        let codex = try await scanner.scan(now: now, historyDays: 1)
        let others = await AdditionalAssistantReader(home: root, appSupport: root.appendingPathComponent("support")).read(now: now)
        var dsh = DeepSeekEventDigest()
        let ms = now.timeIntervalSince1970 * 1000
        dsh.consume(line(["type":"session", "id":"fixture-dsh", "version":4, "delegationDepth":0, "isSeeded":false]))
        dsh.consume(line(["type":"request/header", "time":ms, "data":["header":["config":["provider":"workbuddy-ai", "model":"hy3"]]]]))
        dsh.consume(line(["type":"assistant/message", "time":ms, "seq":1, "data":["usage":["inputTokens":100,"outputTokens":5,"totalTokens":105],"message":["content":"TRANSCRIPT_MUST_NOT_ESCAPE"]]]))
        dsh.consume(line(["type":"request/header", "time":ms, "data":["header":["config":["provider":"workbuddy", "model":"hy3"]]]]))
        dsh.consume(line(["type":"assistant/message", "time":ms, "seq":2, "data":["usage":["inputTokens":30,"outputTokens":2,"cacheReadTokens":7,"cacheWriteTokens":0,"totalTokens":39]]]))
        var seeded = DeepSeekEventDigest()
        seeded.consume(line(["type":"session", "id":"fixture-seeded", "version":4,"delegationDepth":0,"isSeeded":true]))
        seeded.consume(line(["type":"assistant/message","time":ms,"seq":1,"data":["usage":["inputTokens":100,"outputTokens":1,"totalTokens":101]]]))
        let before = seeded.samples.count
        seeded.consume(line(["type":"session/end-seed","time":ms]))
        seeded.consume(line(["type":"assistant/message","time":ms,"seq":2,"data":["usage":["inputTokens":3,"outputTokens":1,"totalTokens":4]]]))
        let result: [String:Any] = ["codex":rows(codex.observedTodayModels),
            "codexCalls":codex.recentUsageCalls.map { ["model": $0.model, "time": $0.at.timeIntervalSince1970,
                "input": $0.usage.inputTokens, "reasoningKnown": $0.reasoningKnown] },
            "workbuddyCalls":others[.workBuddy]?.recentUsageCalls.count ?? 0,
            "claudeCalls":others[.claude]?.recentUsageCalls.map { ["model":$0.model,"write":$0.usage.cacheWriteInputTokens,"writeKnown":$0.cacheWriteKnown] } ?? [],
            "workbuddy":rows(others[.workBuddy]?.observedTodayModels ?? []),
            "claude":rows(others[.claude]?.observedTodayModels ?? []),
            "codebuddy":rows(others[.codeBuddy]?.observedTodayModels ?? []),
            "dsh":dsh.samples.map { ["provider":$0.provider,"model":$0.model,"input":$0.usage.inputTokens,"output":$0.usage.outputTokens,"cacheKnown":$0.cacheKnown] },
            "seededBefore":before,"seededAfter":seeded.samples.count,"seededInput":seeded.usage.inputTokens]
        FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: result,options:[.sortedKeys]))
    }
}
