# Contributing to QC Smart Reader

Thank you for helping make evidence-backed research easier to use. Contributions should keep the project local-first, auditable, and safe around untrusted web content.

By participating, you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Before opening an issue

- Use [GitHub Discussions](https://github.com/vyang472/qc-smart-reader-extension/discussions) for setup questions, workflow ideas, and early design proposals.
- Search [existing issues](https://github.com/vyang472/qc-smart-reader-extension/issues) before filing a duplicate.
- Use the bug template for reproducible failures and the feature template for a concrete user problem.
- Follow [SECURITY.md](SECURITY.md) instead of opening a public issue for a vulnerability or suspected data exposure.

Never include a Pairing Token, API key, private source text, personal browser data, or an unredacted Vault in an issue.

## Good contribution scopes

- A failing fixture for a site extraction regression.
- A narrowly scoped accessibility, onboarding, or error-message improvement.
- A test that demonstrates an evidence-validation or recovery edge case.
- A documentation correction verified against current behavior.
- A small platform-compatibility change with a reproducible test environment.

For a large UI redesign, schema change, new provider, new dependency, or change to a trust boundary, start a Discussion first. This avoids asking contributors to build a direction the project cannot safely accept.

## Development setup

The supported release environment is currently macOS with Chrome 116+, Python 3.9+, and Node.js. Browser tests use Playwright and Chromium.

```bash
git clone https://github.com/vyang472/qc-smart-reader-extension.git
cd qc-smart-reader-extension
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
npm ci
```

For interactive source development:

```bash
bash start.command
```

Then load the repository root as an unpacked extension at `chrome://extensions`.

## Validation

Run the smallest relevant test while iterating, then run the complete gate before requesting review.

```bash
# Companion behavior
.venv/bin/python -m unittest discover -s tests -v

# JavaScript, extraction fixtures, side-panel behavior, and browser tests
node --test tests/*.mjs

# Release-level validation
bash scripts/test_all.sh
```

The full gate intentionally fails when a required browser test is skipped. If part of the gate cannot run in your environment, say exactly which command failed or was unavailable in the pull request; do not present partial validation as a full pass.

Documentation-only changes should at minimum run:

```bash
git diff --check
```

## Project invariants

Changes must preserve these rules:

1. A claim cannot be treated as reviewed without evidence whose source, chunk, and exact quote are valid against the current stored text.
2. Changed or rejected evidence must propagate stale state to dependent outputs.
3. The extension must not store model API keys or call model providers directly.
4. Data APIs remain pairing-token protected and loopback-first.
5. Remote fetches must not create a path to private, loopback, link-local, or reserved networks.
6. Captured web content and model output are untrusted inputs, never executable instructions.
7. The Markdown Vault and SQLite state must stay consistent enough for Vault Doctor to detect drift.
8. Release archives contain only explicit, reviewed inputs and remain reproducible.

## Pull requests

Keep each pull request reviewable as one coherent change. Include:

- the user problem and intended outcome;
- the trust, privacy, schema, or migration impact;
- tests added or updated;
- exact commands run and their results;
- screenshots for visible UI changes;
- a rollback or compatibility note when persistent data or installers change.

Do not mix unrelated refactors into a behavior change. Generated release ZIPs, local Vault data, `.venv`, credentials, and browser profiles must not be committed.

Maintainers may ask to reduce scope, add a regression fixture, or document a new limitation before merging.

## Style

- Preserve the current Simplified Chinese product copy unless the change explicitly introduces localization.
- Use English for code identifiers and technical implementation notes.
- Prefer plain standard-library code and existing project patterns over a new dependency.
- Add comments for security or lifecycle intent, not for syntax that is already obvious.

## License

By submitting a contribution, you agree that it is licensed under the project's [MIT License](LICENSE).
