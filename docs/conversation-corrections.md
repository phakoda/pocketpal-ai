# Memory, search-label and theme corrections

This corrective patch targets PR #3, reviewed head
`94dc29e728b1ae5a54efd95b13881fc4d590b186`. It does not change PR #2.

## Memory entry and management

The visible **Memories & context** entry lives in `ChatView.customContent`, below
its safe-area-aware header, rather than above the header. It remains accessible
without a loaded model. Memory consent, automatic capture, and local-Pal isolation
switches persist immediately; they do not require valid model context/prompt
fields or a Save-and-reopen cycle. Preference writes notify the UI, including
new-chat preference transfer. Unsaved model-form text stays separate.

Use memories is off by default and governs **model** access. Explicit user
management (view/add/erase) stays available with model access off or a model
unloaded. Stored notes stay local; disabling access does not erase them.

## Runtime behavior

Memory schemas are advertised only for positively identified tool-capable
local templates. Non-tool models still receive bounded saved references.
String and text-array user messages both receive references, without modifying
the stored transcript. Media/remote paths do not receive these local memories.
Fewer than 2048 loaded/configured context tokens pauses memory access rather
than breaking the reply.

There are three ways to save notes:

* Add a memory explicitly in the editor (works without a model).
* With Use memories enabled, send `/remember <one short line>`; the app saves
  that exact line after a successful, non-interrupted reply. No native tools
  or extra extraction call are required. The 280 UTF-8 byte limit still applies.
* Also opt into **Automatically remember new facts** (off by default, including
  migration). After a completed reply and after the agent event stream drains,
  the app makes one bounded local extraction call. It accepts at most three
  exact excerpts from the latest user's text, prefixes them with `User:`, and
  rejects invented/paraphrased facts or malformed output. No assistant answer,
  hidden reasoning, tool result, previous memory or system prompt is supplied
  as extraction source. This can still select inappropriate/sensitive text;
  it is not a complete sensitive-data classifier. Review stored notes.

No history is backfilled. Automatic saving adds a model generation and can
return no facts or fail on a model that cannot follow the extraction format.
Oversized extraction prompts are skipped rather than silently truncated.
Capture failure does not roll back the delivered reply, and the status does
not falsely claim a save. Extraction has no tool grammar or UI/TTS callback.

Consent, active context, conversation, Pal and isolation are rechecked. Store
reads/updates and explicit erase confirmations reauthorize inside the relevant
serialized scope queue. A confirmed Pal erase never targets a newly selected
Pal. Stable Pal IDs keep isolated notes available across chats with that Pal.
The memory implementation remains the earlier OptMem-inspired mobile adaptation,
not the upstream Python CLI or its file format.

## TinyFish: unresolved keyless integration

The existing provider is now explicitly labeled **TinyFish (direct API)**. Its
missing-key error explains that it is not the Monid keyless product. This patch
does **not** remove server authentication or claim to implement keyless search.
No alternate search provider is silently substituted.

Verified 2026-09-08:

- https://monid.ai/blog/tinyfish advertises free search without API keys.
- https://monid.ai/SKILL.md (v0.1.7, Authentication) requires an API key.
- https://github.com/monid-ai/cli/blob/3b646052a7833e9d4df40e0d6ef01d940931f449/src/commands/run.ts
  rejects a missing active key.
- https://github.com/monid-ai/cli/blob/3b646052a7833e9d4df40e0d6ef01d940931f449/src/api/client.ts
  authenticates API requests with `Authorization: Bearer`.

The repository's independently added diagnostic run `34276811169` returned
HTTP 401 for direct TinyFish without a key (`MISSING_API_KEY`) and HTTP 401
for Monid `/v1/inspect` without credentials. A supported anonymous
TinyFish-through-Monid request/response contract was not verified. The direct API remains a material deviation from the original request.

## Theme and remaining device verification

The controls' root, dialog/scroll area, inputs and text explicitly use the active
theme. Moving the entry below the header removes its placement outside the
header's top-inset treatment. This is not proof that all reported white areas
are resolved: no user screenshot, native renderer, simulator or device was
available to reproduce those pixels.

Run `node scripts/test-conversation-features.cjs` and
`node scripts/test-conversation-controls.cjs`. The latter is a synthetic
hook/element harness, **not** a real React Native render/layout test. The existing
regression workflow is extended with the controls checks while preserving its
real application typecheck; the corrected code must pass it after publishing. APK/IPA builds, the
existing Jest suite, lint, native inference and live search still require
verification. English UI copy still needs localization.
