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

This file is candidate release copy. It does not prove that the v0.9.5 GitHub Release exists or that Chrome Web Store upload, submission, or approval has occurred.

The locale-specific Web Store screenshots currently in the repository were captured and verified for v0.9.4. They are prior-release references only: they were not recaptured from v0.9.5 and do not show the new context-menu selection flow.
