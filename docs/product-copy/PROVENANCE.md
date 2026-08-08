# Product-copy provenance

A short record of how the user-facing prose in this repository was produced.
Shipped copy lives in `README.md`, `SECURITY.md`, `CHANGELOG.md`,
`docs/GATEWAY-ARCHITECTURE.md`, `site/index.html`, the release notes, and the
dashboard string catalogs. Nothing in this directory is canon.

## Record

- **2026-08-08 — phase 2 brief prepared.** A product-copy brief was written
  locally covering the marketing site, README sections, the dashboard string
  catalog, and the security-facing prose. It fixed the product truths the copy
  was not allowed to drift from: same-machine broker, asymmetric registration
  and selection, acceptance is not completion, and "local" describing the
  broker and route rather than model inference. The first attempt to run it was
  refused by the local execution permission layer before any transmission; no
  prompt, repository content, credential, or account detail left the machine.
- **2026-08-08 — phase 2 brief executed.** With the user's direct
  authorization, the brief was run verbatim through `claude` against model
  `claude-opus-4-6` as a one-shot, tool-free, non-persistent call. The output
  was an unreviewed draft covering the site IA, README and security prose, and
  a first dashboard catalog.
- **2026-08-08 — live-dashboard deltas.** A second authorized one-shot,
  tool-free run against the same model produced the public prose describing the
  opt-in `embassy dashboard --live` companion for the README, security policy,
  changelog, release notes, and site.
- **2026-08-08 — editorial passes.** Every draft was edited against the
  implementation, then reviewed adversarially in two rounds before anything
  reached a user-facing surface. Round 2 rescoped the "no HTTP listener" claims
  to `embassy serve`, documented the live companion in the architecture canon,
  corrected the static dashboard's refresh and filename claims, and published
  the `unconfirmed` delivery state and the delivery-token commands.
- **2026-08-08 — drafts retired.** The raw drafts and the writer brief were
  removed from the published tree once their content had been edited into the
  shipped surfaces. They were superseded copies, not documentation, and would
  have become a competing source of truth.

## Standing rules

- Model-drafted copy is a draft. It ships only after an editorial pass against
  the code and the standing adversarial review.
- No raw model transcript, writer brief, or assistant-voice preamble belongs in
  the published tree.
- No local absolute path, account name, or personal identifier appears in any
  file here — the same rule `SECURITY.md` asks vulnerability reporters to
  follow.
