# QC Smart Reader Privacy Policy

Last updated: 2026-08-15

QC Smart Reader is a local-first research reader. Its single purpose is to turn material the user intentionally selects from web pages, PDFs, public YouTube captions, and selected text into locally stored, quote-backed research claims and artifacts for human review. The product uses a deterministic local template by default; optional model providers are available only when the user selects and configures one.

## Data the extension handles

When the user starts a capture or model action, QC Smart Reader may handle:

- the active page title, URL, selected text, and extracted page content;
- links, headings, code blocks, images, attachments, and pagination metadata found in that content;
- PDF files or URLs and YouTube URLs or captions explicitly supplied by the user;
- the user's questions, project settings, review decisions, and generated research outputs;
- a local pairing token used only to authenticate the extension to the companion service on the same computer.

QC Smart Reader does not sell data, use it for advertising, build advertising profiles, or transmit it to the developer for analytics.

## Local storage

Captured sources, notes, evidence, jobs, and generated outputs are stored by the companion service in a SQLite database and Markdown Vault selected by the user. Extension settings, the loopback Pairing Token, and temporary recovery queues are stored in Chrome extension storage on the same device. The Companion also keeps its copy of the Pairing Token and any model API key in local credential files with owner-only permissions; model API keys are not stored in Chrome extension storage.

## Model providers and data sharing

Model use is optional. Before the first model action, the product asks for affirmative consent.

- With **Codex CLI**, the local companion launches the user's installed Codex CLI. The CLI may send the prompt and included source content to OpenAI under the user's OpenAI account and applicable OpenAI terms.
- With **OpenAI-compatible** or **Anthropic**, the companion sends the prompt and included source content to the endpoint explicitly configured by the user. That provider processes the data under its own terms and privacy policy.
- The deterministic local template is the zero-configuration default for Quick Start. It generates a clearly labeled draft locally, makes no external model call, is not an AI summary, and requires human review before a claim becomes reviewed.

QC Smart Reader sends only the material required for the model action the user initiated. It does not run background model analysis without a user action.

## Browser permissions

- `scripting`: extract content only from an HTTP(S) page the user chooses to read or process.
- `http://*/*` and `https://*/*`: read the URL, title, and content of user-selected web pages, process HTTP(S) batch URLs in temporary tabs, and communicate with the loopback Companion. These permissions do not include file or other URL schemes and are not used for passive browsing-history collection.
- `downloads`: export a file requested by the user.
- `storage`: retain settings and recoverable local queues.
- `contextMenus` and `sidePanel`: provide the selected-text and side-panel workflows.

## Retention and deletion

The user controls the local Vault and can back it up, archive it, or delete it. Removing the Chrome extension clears Chrome-owned extension storage but intentionally does not delete the companion Vault. Deleting the Vault or companion data directory is a separate, explicit local action.

## Security and Limited Use

The companion binds to the loopback interface by default, requires a random pairing token for all data APIs, and restricts browser origins. QC Smart Reader's use of information received from Chrome APIs adheres to the Chrome Web Store User Data Policy, including the Limited Use requirements.

## Changes and contact

Material changes to data handling will be disclosed before the changed behavior is used. Report vulnerabilities or sensitive privacy issues through [GitHub private vulnerability reporting](https://github.com/vyang472/qc-smart-reader-extension/security/advisories/new); do not place tokens, API keys, private source material, or exploit details in a public issue. Non-sensitive support requests can use [the project's GitHub issue tracker](https://github.com/vyang472/qc-smart-reader-extension/issues).
