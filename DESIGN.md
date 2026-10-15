# AgentFlow design

Near-black shell, SF system type, narrow Codex-like conversation sidebar, fixed bottom composer, compact source-colored activity capsule, conversation workflow and optional usage inspector.

Use actual activity to illuminate source colors: GPT #C291FF, Claude #ED9C75, WorkBuddy #4AD6BF, DSH #7DA3FF, CodeBuddy #B09CFF. Avoid paragraphs under selectors, duplicated role subtitles and enable checkboxes. Necessary details live behind a compact disclosure or tooltip. Output is always text, never interpreted markup.

Each stage has three accessible selectors without repeated visible labels. First and last providers are open. Middle nodes have drag handles, insertion slots and a deletion target; 54px proximity snapping and short FLIP transitions preserve spatial continuity. Keyboard add/move/delete controls are available.

Motion uses transforms and opacity, 180–240ms rearrangement, subdued capsule transitions and reduced-motion fallback. Do not animate streamed text or displace a composing Chinese IME input. Preserve focus, scroll and local drafts while background discovery refreshes state. New-chat navigation during submission never pulls the user back.

At 820–1440 logical pixels the main content remains usable and the inspector collapses. Model labels include route/source in their menu, with exact compound IDs retained internally. APIs expose compact connection forms with optional advanced declared reasoning levels; secrets never prefill.

0.3 uses separate rectangular agent/flow cards. Dragging near either half of an entire card chooses a nearby insertion position; the removal area is always visible to avoid start-drag layout shift. Unready providers/models are gray and disabled, with concise login/connection affordances. Page, thread and dialog changes crossfade with a 5px shift over 200ms; streamed updates preserve the surface. Sidebar delete buttons appear on hover/focus. Supplied raster mark is used for the macOS icon unchanged except proportional packaging.
