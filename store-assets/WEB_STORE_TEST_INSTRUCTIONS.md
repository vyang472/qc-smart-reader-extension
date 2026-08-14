# Chrome Web Store reviewer test instructions — QC Smart Reader v0.9.2

**Handoff status:** pre-release draft. Do not paste it into the dashboard until every `<PUBLISHED_VERSION>` sentinel has been replaced with the published version and both public links and checksums have been verified from a signed-out browser session.

## Dashboard-ready instructions

QC Smart Reader requires macOS, Chrome 116 or later, and the free local Companion from the same release. No account, payment, API key, Codex CLI, or external model is required for the core review flow.

1. Download the Companion and checksum file:
   - `https://github.com/vyang472/qc-smart-reader-extension/releases/download/v<PUBLISHED_VERSION>/qc-smart-reader-companion-<PUBLISHED_VERSION>.zip`
   - `https://github.com/vyang472/qc-smart-reader-extension/releases/download/v<PUBLISHED_VERSION>/SHA256SUMS`
2. In Terminal, verify and install the per-user Companion:

   ```bash
   cd ~/Downloads
   RELEASE_VERSION="<PUBLISHED_VERSION>"
   grep "qc-smart-reader-companion-${RELEASE_VERSION}.zip" SHA256SUMS | shasum -a 256 -c -
   mkdir -p "qc-smart-reader-companion-${RELEASE_VERSION}"
   unzip "qc-smart-reader-companion-${RELEASE_VERSION}.zip" -d "qc-smart-reader-companion-${RELEASE_VERSION}"
   cd "qc-smart-reader-companion-${RELEASE_VERSION}"
   bash install.command
   ```

   Expected: the installer reports a healthy Companion at `http://127.0.0.1:37621`, prints the Pairing Token, and copies the token to the clipboard.
3. Open the installed QC Smart Reader extension. Leave **Interface language** on **Auto (browser)** on an English-language Chrome profile, or explicitly choose **English**. In **Settings**, enter `http://127.0.0.1:37621`, paste the Pairing Token, and choose **Test local Companion**.

   Expected: the status says the local Companion and Pairing Token are ready, and Quick Start becomes available.
4. Open the public IANA fixture `https://example.com/` in a normal tab. Return to QC Smart Reader **Read** and start Quick Start from the current page.

   Expected: QC Smart Reader saves the page in the local Vault, labels the run as the local template / Mock mode with no external model call, and shows a draft claim beside an exact quote from the page. The claim remains unreviewed.
5. Compare the claim with its exact quote. Confirm that both supported and unsupported decisions are available, then choose supported for this fixture.

   Expected: the claim remains pending until the human decision, then changes to `reviewed` and Quick Start reports completion. Choosing unsupported instead would persist a `rejected` decision.
6. Close and reopen the side panel.

   Expected: the same claim, exact quote, and human decision are restored from the local Companion; both decision buttons remain disabled for the decided claim.

Optional Codex CLI, OpenAI-compatible, and Anthropic features are not needed for this review. Quick Start always uses the deterministic local template and does not send the fixture or Pairing Token to an external model or the developer.

The English interface intentionally covers setup, pairing, Quick Start, core current-page feedback, and First Evidence. Advanced Batch, Agents, most of Knowledge, Deliverables, and project/model controls currently remain in Simplified Chinese and show an English notice where that boundary begins. This listing does not claim a fully English advanced workspace.

## Cleanup

From the extracted Companion directory, run:

```bash
bash uninstall.command
```

Expected: the per-user service is removed. The default uninstall deliberately preserves the local Vault; it does not purge research data without a separate explicit destructive command. Remove the Chrome extension through Chrome after testing if desired.

## Publisher verification before submission

- Replace every `<PUBLISHED_VERSION>` sentinel with the published numeric version, then confirm both release URLs return public assets without authentication. Keep the shell variable name `RELEASE_VERSION` unchanged.
- Confirm the checksum command reports `qc-smart-reader-companion-<published-version>.zip: OK`.
- Repeat the complete flow on a clean macOS user account with the exact extension ZIP submitted to the Web Store.
- Do not provide the reviewer with a reused Pairing Token, API key, password, private Vault, or private source URL.
