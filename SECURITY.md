# Security Policy

QC Smart Reader handles browser content, local files, model credentials, and a durable research Vault. Please report security problems privately so users can be protected before details are published.

## Supported versions

| Version | Security fixes |
| --- | --- |
| 0.9.x | Supported |
| Earlier development versions | Not supported |

Upgrade to the newest published release before reporting a problem that may already be fixed.

## Report a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/vyang472/qc-smart-reader-extension/security/advisories/new). Do **not** open a public issue for a vulnerability, suspected credential exposure, or a bypass of a privacy boundary.

Include only what is necessary:

- affected version and macOS / Chrome / Python versions;
- impact and the trust boundary crossed;
- minimal reproduction steps or a small synthetic fixture;
- whether a Pairing Token, API key, local file, or private source may be exposed;
- any suggested mitigation.

Never send a real API key, Pairing Token, private Vault, browser profile, or sensitive source document. Replace secrets and source text with synthetic values. If private vulnerability reporting is unavailable, contact the repository owner through the contact method on [their GitHub profile](https://github.com/vyang472) and ask for a confidential channel without disclosing vulnerability details publicly.

The project is maintained on a best-effort basis and cannot promise a response SLA. A useful report will be acknowledged, reproduced where possible, assigned a severity, and coordinated with a fix and release note before public disclosure.

## Security boundaries

The supported configuration assumes:

- the Companion listens on loopback and is not exposed to a LAN or the internet;
- the macOS user account and local Vault directory are trusted by that user;
- only the QC Smart Reader extension receives the Pairing Token;
- users review provider settings and consent before sending source material to a model;
- web pages, PDFs, captions, and model responses are untrusted inputs.

The project does not claim to protect data after the local macOS account is compromised, after a user deliberately exposes the Companion with non-loopback options, or after material is sent to a third-party model provider selected by the user.

## High-value report areas

- bypassing Pairing Token authentication or allowed origins;
- making a remote PDF or subtitle fetch reach a private network target;
- escaping the restricted Codex CLI execution environment;
- reading a local file outside an explicitly allowed PDF directory;
- leaking an API key or Pairing Token into Chrome storage, logs, exports, or model prompts;
- executing instructions embedded in captured content;
- archive traversal, unsafe installer paths, upgrade data loss, or rollback failure;
- accepting a reviewed claim whose evidence quote does not exist in its current source chunk.

Ordinary extraction errors, unsupported sites, and non-sensitive crashes belong in the public bug tracker.

## Release integrity

Official release assets are published on the repository's [Releases page](https://github.com/vyang472/qc-smart-reader-extension/releases). Verify downloaded artifacts against the accompanying `SHA256SUMS` before installation. Release archives are expected to be built from committed allowlisted inputs by `scripts/release.py`.
