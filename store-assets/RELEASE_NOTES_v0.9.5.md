# QC Smart Reader v0.9.5

QC Smart Reader v0.9.5 adds a direct, zero-model path from a selected passage to pending local evidence.

## Highlights

- Select up to 800 Unicode characters on an HTTP(S) page, right-click, and choose **Save selection as pending evidence (local, no model)**.
- The extension captures the exact quote plus bounded page context and asks the local Companion to persist one project-scoped pending claim/evidence pair with a resolved Source Replay target.
- The save action does not call Codex CLI, an API model, an agent, or developer telemetry. The evidence remains pending until a person explicitly accepts or rejects it.
- A bounded recovery item is kept in `chrome.storage.local` across a browser restart. Failed or unpaired saves remain queued; the item is deleted after the Companion confirms the durable write and the extension acknowledges it. Clearing the extension's stored data or uninstalling the extension also lets Chrome remove this extension-owned queue.
- If the Companion is from an older release and does not advertise `selection_first_evidence_v1`, the extension leaves the selection queued and asks the user to install the matching v0.9.5 Companion.

## Compatibility

- Extension: v0.9.5
- Companion: v0.9.5
- Chrome: 116+
- Python: 3.9+
- Companion API: 1 (unchanged)
- Vault schema: 1 (unchanged)
- Minimum compatible extension reported by Companion: v0.9.0 (unchanged)

Use the v0.9.5 Extension and Companion archives from the same GitHub Release and verify both with `SHA256SUMS`.

## Honest release status

The public v0.9.5 GitHub Release and its three checksum-verified assets are available at [GitHub Releases](https://github.com/vyang472/qc-smart-reader-extension/releases/tag/v0.9.5). Chrome Web Store upload, submission, and approval have not occurred.

The locale-specific Web Store screenshots were regenerated twice from independent clean browser profiles using the v0.9.5 extension, the real v0.9.5 Companion, and a public deterministic fixture. Both runs passed the Replay-contract, sensitive-data, layout, 640×400 RGB, and deterministic-hash checks and reproduced the tracked PNGs byte for byte. They show the carried-forward Quick Start pending/reviewed Replay states, not the new context-menu selection flow, and do not prove Chrome Web Store upload, submission, or approval.
