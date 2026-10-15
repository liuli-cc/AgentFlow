# AgentFlow 0.3

## Register
product

## Platform
Local macOS Electron desktop app, Chinese interface, native dialogs.

## Users and purpose
Enter a request, let a chosen starter model recommend a team from authenticated local agents and verified APIs, inspect and edit the proposal, then explicitly confirm execution. Every planning, design, execution and review provider/model is selectable. Model review is followed by a human accept/revise decision.

## Confirmed direction
TokenLens colors, dark capsule, restrained source-colored glow and smooth motion. Codex-like persistent chat sidebar and bottom composer. Remove repeated field explanations and duplicate role subtitles; keep essential statuses and accessible names.

## Workflow
- Every request, including chat continuation, invokes the selected read-only starter.
- Recommendation uses detected available models only and stops for human confirmation.
- Drag agent tiles into the workflow, reorder or drag middle nodes to delete. Nearby slots snap visibly. Keyboard operations remain available.
- A new chat is always available. Independent workspaces can run concurrently; the same workspace is serialized.
- Model and reasoning can change for waiting stages; in-flight calls retain their original settings.
- First launch discovers known CLIs and recognizable applications in system/user Applications. Automatic rescans update newly installed apps; unknown interfaces remain disabled until a supported connection is ready.
- Custom OpenAI Chat, Responses and Anthropic APIs are stored locally, with Keychain-backed encrypted secrets and per-model capabilities.
- Empty workspace selection creates a private task folder; explicit folders come from the native chooser.

## Evidence and boundaries
Installed, authenticated, catalog-listed and actually executed are distinct states. Per-stage usage includes the starter and retries; unknown counters remain unknown. TokenLens software samples are separate from task events. External outputs are untrusted text. There is no renderer network access, shell interpolation or local network control server.

## 0.3 interaction requirements
Enter sends; Shift+Enter inserts a newline; IME confirmation never sends. Sidebar records can move to OS Trash while project files remain. Agent cards are rectangular and magnetically insert near whole workflow cards. Unready cards are gray and cannot be selected; login and connection verification precede use. Navigation/dialog transitions are brief and reduced-motion aware; background updates do not animate the page. The supplied three-purple-bars image is the app icon. Software telemetry shows only models observed in actual logs, with independently attributed usage.
