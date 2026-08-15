# Chrome Web Store reviewer test instructions — QC Smart Reader v0.9.5

**Handoff status:** candidate instructions for v0.9.5. The v0.9.5 GitHub Release, public-link verification, clean-account run, Web Store upload, submission, and approval are still pending. Do not paste these instructions into the dashboard until the public assets exist and the publisher has repeated the complete flow with the exact candidate extension ZIP on a clean macOS account. The screenshots currently in the repository are verified v0.9.4 prior-release references, not v0.9.5 captures or proof of submission.

## Dashboard-ready instructions

QC Smart Reader requires macOS, Chrome 116 or later, and the free local Companion from the same release. No account, payment, API key, Codex CLI, or external model is required for the core review flow.

1. Download the Companion and checksum file:
   - `https://github.com/vyang472/qc-smart-reader-extension/releases/download/v0.9.5/qc-smart-reader-companion-0.9.5.zip`
   - `https://github.com/vyang472/qc-smart-reader-extension/releases/download/v0.9.5/SHA256SUMS`
2. In Terminal, verify and install the per-user Companion:

   ```bash
   cd ~/Downloads
   RELEASE_VERSION="0.9.5"
   grep "qc-smart-reader-companion-${RELEASE_VERSION}.zip" SHA256SUMS | shasum -a 256 -c -
   mkdir -p "qc-smart-reader-companion-${RELEASE_VERSION}"
   unzip "qc-smart-reader-companion-${RELEASE_VERSION}.zip" -d "qc-smart-reader-companion-${RELEASE_VERSION}"
   cd "qc-smart-reader-companion-${RELEASE_VERSION}"
   bash install.command
   ```

   Expected: the installer reports a healthy Companion at `http://127.0.0.1:37621`, prints the Pairing Token, and copies the token to the clipboard.
3. Open the installed QC Smart Reader extension. Leave **Interface language** on **Auto (browser)** on an English-language Chrome profile, or explicitly choose **English**. In **Settings**, confirm **Download Companion v0.9.5** targets the Companion URL in step 1 and **Verify SHA256SUMS** targets the checksum URL in step 1. Then enter `http://127.0.0.1:37621`, paste the Pairing Token, and choose **Test local Companion**.

   Expected: both setup links open the public, version-matched GitHub Release assets in a new tab without exposing the Pairing Token, the status says the local Companion and Pairing Token are ready, and selection saving becomes available. A pre-v0.9.5 Companion without `selection_first_evidence_v1` would leave a selection queued and display a same-version upgrade prompt instead of attempting the unsupported endpoint.
4. Open the public IANA fixture `https://example.com/` in a normal tab. Select the sentence beginning **This domain is for use in illustrative examples**, right-click, and choose **Save selection as pending evidence (local, no model)**.

   Expected: QC Smart Reader opens the side panel, saves the exact selected quote plus bounded captured context through the local Companion, and shows one pending claim/evidence pair with Source Replay. The action starts no Codex CLI, API model, agent, or developer telemetry. The claim remains unreviewed.
5. Compare the claim with its exact quote. Confirm that both supported and unsupported decisions are available, then choose supported for this fixture.

   Expected: the claim remains pending until the human decision, then changes to `reviewed`. Choosing unsupported instead would persist a `rejected` decision. Choose **Replay** and confirm it reports **Captured snapshot verified**, highlights the exact quote inside **Captured context**, and identifies the captured selection record.
6. Close and reopen the side panel.

   Expected: the same claim, exact quote, Replay target, and human decision are restored from the local Companion; both decision buttons remain disabled for the decided claim. The canonical-source action is labeled as a fallback and does not claim a precise remote position.

Before Companion confirmation, a bounded pending exact quote and captured context are held in `chrome.storage.local` only for browser-restart recovery. An unpaired or failed save remains queued; after a durable Companion write and successful queue ACK, the extension deletes the recovery item. Clearing the extension's stored data or uninstalling it also lets Chrome remove this extension-owned queue. It is not developer telemetry and never triggers a model call.

Optional Codex CLI, OpenAI-compatible, and Anthropic features are not needed for this review. The right-click selection flow never sends the fixture or Pairing Token to an external model or the developer. Quick Start remains available as a separate whole-page deterministic local-template flow.

The English interface intentionally covers setup, pairing, Quick Start, core current-page feedback, First Evidence, and Replay controls. Advanced Batch, Agents, most of Knowledge, Deliverables, and project/model controls currently remain in Simplified Chinese and show an English notice where that boundary begins. This listing does not claim a fully English advanced workspace.

## Cleanup

From the extracted Companion directory, run:

```bash
bash uninstall.command
```

Expected: the per-user service is removed. The default uninstall deliberately preserves the local Vault; it does not purge research data without a separate explicit destructive command. Remove the Chrome extension through Chrome after testing if desired.

## Publisher verification before submission

- Confirm both v0.9.5 release URLs return public assets without authentication before submission.
- Confirm the checksum command reports `qc-smart-reader-companion-0.9.5.zip: OK`.
- Repeat the complete flow on a clean macOS user account with the exact extension ZIP submitted to the Web Store.
- Do not provide the reviewer with a reused Pairing Token, API key, password, private Vault, or private source URL.
