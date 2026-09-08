# Conversation features — draft implementation

## Status

This is a **draft**, not a merged feature or a published pull request. The implementation was prepared against `phakoda/pocketpal-ai` commit `6506928aac88b283b3dc1f1625a36a99adbd50f3`. Full repository installation, application typechecking, linting, iOS/Android builds, and live-provider testing were not possible in the preparation environment. Run these checks before treating this as mergeable.

## Controls

Open **Conversation options** above the regular chat view. The video-Pal screen is unchanged. Conversation options can be staged before the first message; they are copied into the newly-created session and the next new-chat defaults reset, with memories off. Compaction, memory consent and thinking budgets are persisted separately from model sampling settings, so these app-only options are not forwarded to remote inference APIs.

The context setting remains global, matching the existing application design. The editor shows the selected model's native GGUF maximum, falling back to its repository GGUF metadata. Unknown maximums are clearly labelled; the new editor uses the currently loaded allocation or a conservative 4096-token ceiling. The runtime uses the minimum of configured context, actual loaded allocation, and known model maximum.

Increasing a number does **not** resize an existing native context: reload the model. This draft does not overhaul every model-loading path to clamp inherited global settings when switching models. The inference wrapper still enforces the smaller runtime limit for text. Native allocation can therefore be larger than the effective prompt limit after a model switch until settings are corrected and the model is reloaded.

The memory estimate reuses the app's estimator with the selected context, KV cache settings, projection model and configured paired draft. Because GGUF metadata here does not describe per-layer sliding-window patterns, the editor conservatively projects full KV caches for all target layers. It is an estimate, not a guarantee of available RAM. Embedded speculative-draft overhead, runtime/system buffers and device behavior can differ. Missing/invalid metadata and remote models do not provide a reliable context-dependent estimate.

The model system-prompt editor updates the model's existing persisted `chatTemplate.systemPrompt`. It applies across conversations using that local model. Existing Pal system prompts retain precedence. This deliberately does not replace the existing Pal prompt-resolution rules.

## Context compaction

`runtime.ts` wraps the existing completion engine for each agent run. It measures the actual Jinja-formatted text prompt, including tool schemas, using the loaded model's tokenizer before each completion step. It reserves output space and 32 control-token slots. Compaction begins at 85% of the remaining prompt budget, not 85% of raw configured context.

The reducer and conversation database are not changed. The full original messages remain visible/exportable. Older complete user turns are summarized; assistant tool calls and their matching results are retained or removed together. The current user/tool turn is always pinned. The system prompt is preserved. Summary data is attached to a retained user message as quoted reference data, never promoted into a privileged system prompt.

Summary generation is sequential on the same local engine, with tools, hidden thinking, response schemas and custom stop strings excluded. Every summary chunk is measured too. There is a 64-pass work limit. Empty, oversized, aborted and failed summaries fail visibly; they never cause history deletion. No summaries are cached across runs in this draft, avoiding stale summaries after message edits/model changes but increasing repeated compaction cost.

A current turn or large tool round that cannot fit even after removing older turns fails explicitly. The draft does not split or silently truncate an oversized current message/tool result. Native tokenizer/formatter parity and control-token headroom still require on-device testing.

Automatic compaction currently supports **local text-only inference**. Media requests keep the existing native path and display an explicit status; no claim is made that text-token counts account for image embeddings. Remote inference is unchanged. Local summary processing creates no extra network request.

## Memories and OptMem compatibility

The mobile implementation is a **clean-room adaptation of OptMem's documented design**, not a bundled Python interpreter, a direct invocation of the upstream executable, or a byte-compatible OptMem database. No upstream source code has been copied into it. This is a material difference from a literal dependency integration and should be reviewed before accepting the feature as a complete implementation of the original request.

Memory storage supports two scopes. By default, opted-in local chats use the shared store. When **Keep memories separate for <Pal>** is enabled for a local Pal, that Pal gets a separate AsyncStorage-backed log keyed by its stable Pal ID. Every opted-in chat using that Pal reads and writes only that Pal-scoped store; the shared store and every other Pal store are excluded. The setting is Pal-level, so it follows the Pal across conversations, while each conversation still keeps its own `useMemories` consent toggle. Changing a Pal's isolation setting during an active run invalidates the existing memory tool and requires a new send before any further memory access.

Pal isolation does not copy or migrate existing notes between scopes. Enabling it starts from that Pal's existing isolated store (empty if none exists); disabling it returns future opted-in chats to the shared store. Erasing from the editor deletes only the currently selected scope, so erasing one Pal's memories does not erase shared memories or other Pals. Stable Pal IDs, not display names, define ownership. Pal deletion cleanup/export policy is still a pre-merge product/privacy decision.

The memory log is append-only until the user explicitly erases its selected scope. Each note is one non-empty line of at most 280 UTF-8 bytes, attributed to its source conversation and timestamp. Identical notes are deduplicated. Cached summaries form aligned binary ranges with inclusive endpoints. The `memo` talent supports `wake`, `note`, `nap`, `recall`, `zoom`, and `forget`. `forget` invalidates a summary and its ancestors, **not** a raw note. Model-generated summaries are supplied through explicit `nap` tool calls; no background worker silently compresses memory.

Important differences from upstream:

* Storage is serialized local AsyncStorage JSON, not fixed-width `LOG.txt`/`TREE` files. Writes are queued to avoid lost updates. There is a 10000-note mobile safety ceiling, not unbounded storage.
* Recall performs bounded, paginated **literal substring** search, not arbitrary regular expressions. This avoids executing model-supplied expensive regex on the UI thread.
* The startup view adapts to context size, with smaller tool-read pages than upstream's 96-line default. Omitted nodes are reported and remain retrievable. At least 2048 loaded/configured context tokens are required when memories are enabled.
* There is no upstream file import/export, config CLI, byte-format interoperability or compatibility test against the Python test suite in this draft.

Every conversation defaults to memories off. Disabled conversations do not read or write memory storage and do not advertise the `memo` tool. Consent is rechecked for every native step and every tool call, including inside the serialized write queue. A stale tool from another conversation/model or a stopped run cannot continue using memory. Only literal boolean `true` is consent.

Notes are shared only across opted-in local text chats. They are not injected into remote models or media chats in this draft. Turning off memories stops future access but does not erase saved notes. **Erase all shared memories** deletes the log and cached summaries, after a confirmation, without deleting conversations. The UI can display memory summaries and add a user-written note after consent has been saved.

Memory storage is local but **not newly encrypted by this feature**. App backups and the operating system's storage policy remain relevant. Conversation deletion does not delete shared notes; the UI explicitly explains separate erasure. Native settings cleanup hooks for deleted sessions and individual-note deletion/export require further work. Retrieved memories and web content are marked as reference data; prompt wording is not a hard security boundary against prompt injection or private-data disclosure through an enabled search tool.

## TinyFish search

`TinyFishProvider` implements the existing search-provider interface, so PocketPal's consent, Keychain credential storage, result budgeting, citation presentation and read-URL allowlisting remain in use. Select **TinyFish** under **Settings → Internet Search**, accept the existing disclosure and save a TinyFish API key. A Pal must still have the existing `web_search` talent enabled; this draft does not add search tools to every ordinary conversation.

The adapter uses the documented **direct TinyFish Search API**:

```text
GET https://api.search.tinyfish.ai?query=...
X-API-Key: <key stored in Keychain>
```

It is **not the Monid keyless proxy advertised in the supplied blog**. A stable, inspected Monid endpoint contract was not available during preparation. TinyFish's own current documentation requires a key. This deviation should be agreed before merging; no invented Monid routes or request schemas are used.

The provider normalizes titles/snippets/URLs, limits counts, rejects unsafe URL forms, applies a 20-second timeout, checks status/JSON and declared/post-read payload size, and avoids reflecting raw provider errors or credentials. It requests redirect rejection; actual React Native redirect semantics must be verified on both platforms. Post-read size checks are not a guaranteed streaming download cap on React Native. The existing provider interface does not propagate per-agent abort signals, so a stopped search can remain in flight until completion/timeout, though the runner's abort handling prevents subsequent generation. Existing `read_url` behavior remains unchanged and can use its existing fallback reader; this is not a TinyFish browser-automation integration.

No real search query was sent with a live key during preparation. Tests use synthetic responses matching the documented envelope.

## Thinking limit

The pinned `llama.rn@0.13.0-rc.1` exposes `thinking_budget_tokens`. The wrapper forwards the user's numeric budget only for local text models whose detected metadata supplies both thinking start/end tags. A blank setting leaves native/model defaults unchanged; zero requests immediate closure of a supported thinking block. Unknown/unsupported tags produce a clear error rather than a misleading prompt-only approximation.

The effective budget is clamped to leave room for a visible answer within that generation's output cap. This is a budget **per model completion step**, not a sum across all tool turns. The existing thinking on/off/effort controls remain separate. Numeric limits are not implemented for remote providers or media input. Test model-specific closure behavior and actual token counts on devices before release.

## Validation and merge gates

Run the added standalone regression harness:

```sh
node --test scripts/test-conversation-features.cjs
```

It uses the repository's TypeScript dependency when available, with a global TypeScript fallback. Its native/AsyncStorage/MobX boundaries are explicit mocks. It is not an emulator test and is not automatically added to the existing Jest/CI workflow.

Before merge: run the full existing typecheck, lint and Jest suite; verify all integration anchors on the base checkout; wire the regression harness into CI; localize the English UI copy; test small/large context models, model switching, tool follow-ups, failed summaries, stop during compaction/search, app restart, memory opt-out and erasure; validate native thinking caps and RAM estimates on Android/iOS; test a live TinyFish key and errors; review OptMem/Monid compatibility deviations and upstream licensing before any literal source port.

## Primary implementation references

* PocketPal base: https://github.com/phakoda/pocketpal-ai/commit/6506928aac88b283b3dc1f1625a36a99adbd50f3
* OptMem design: https://github.com/VictorTaelin/OptMem — reviewed tree `1fb164cf39028047781f72ac3bb1e5a691c1dcb0`; README blob `4a49709b9b35d208fae5d9fa3ce05d26954d6ee0`.
* Native budget contract: https://github.com/mybigday/llama.rn/blob/v0.13.0-rc.1/src/types.ts — reviewed blob `e922c61bd4e7f392888a8c4c05f0411293d2fe40`.
* TinyFish direct search: https://docs.tinyfish.ai/search-api — checked September 8, 2026.
* Requested Monid article: https://monid.ai/blog/tinyfish — checked September 8, 2026.
