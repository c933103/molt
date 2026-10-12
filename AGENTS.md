# Working in molt

Read [README.md](README.md), the credential/content boundaries and [Pages workflow](.github/workflows/pages.yml) before editing. Preserve the HTML 4.0 Strict/no-CSS interface, fixed API destinations, existing access boundaries and explicit authorization requirements for live actions.

## Keep changes and evidence focused

- Define one finishable outcome, its affected behavior and observable acceptance checks. Keep implementation, meaningful regressions and compact failure fixtures together; split unrelated audits or archive work.
- Keep bulky run logs, captures, APKs and duplicate source dumps on durable evidence refs or established artifact storage. In the implementation PR, retain one compact receipt: exact source and test revision, environment, command/run, outcomes, failures, untested scope, artifact hashes where bytes matter, and immutable archive links.
- Preserve existing archives, retention commitments and recovery paths. Inspect consumers, licensing and packaging before moving anything; verify the archived bytes and accessibility first. This guidance authorizes no deletion, expiry or history rewrite.
- Test current behavior, data integrity and compatibility directly. Do not add permanent historical-source hash gates, recursive inverse adapters or full-tree reconstruction as ordinary CI. A one-time migration comparison is distinct from a lasting product contract.
- Match acceptance to the requirement and risk. Preserve negative controls and the original failure; never silently weaken assertions, skip required checks or relabel failed aggregates as passed. A reviewed replacement is required before retiring an existing gate.
- Require applicable current-head CI and risk-focused review before an authorized merge; re-review affected fixes and integrations. Record published, tested, reviewed, merged and released separately. Missing, blocked, cancelled and failed checks remain distinct.
- Keep public records standalone and free of credentials, secrets, private tracker links and unrelated private data. Use the designated private reporting channel for sensitive security findings.

## Client contracts and verification

- Preserve credential destination restrictions, encrypted browser-storage behavior, bounded recovery import/export, key redaction, disconnect races, loopback/exact-page CLI binding and explicit mutation confirmation. Recovery format fixtures and migration fixtures protect real compatibility and must remain.
- Use synthetic keys and controlled responses. Do not read real credentials, connect accounts, publish, vote, delete or perform other live mutations to validate a change. Unknown mutation outcomes require reconciliation rather than automatic retry.
- For code changes, run `node --test tests/*.test.mjs` and `python3 check_html4.py`; regenerate the embedded script policy with `python3 update_csp.py` when the script changes, then check the resulting diff and rerun relevant tests. CSP hashes bind executable content and are not obsolete historical-source gates.
- The Pages workflow stages only `index.html` and `cli.mjs`; root guidance, tests and archives are not deployed. Git source archives still include root documentation. Preserve this explicit deployment boundary.
- For documentation-only work, check content/links and confirm deployed/generator inputs are unchanged. The PR workflow still runs its existing tests and CSP consistency check; keep applicable current-head CI and independent scoped review before an authorized merge.
- Published source, passing synthetic tests, an actual deployment and verified live behavior are separate states. A merge to `main` triggers deployment under the existing workflow; opening this guidance PR does not authorize that merge or any account action.
