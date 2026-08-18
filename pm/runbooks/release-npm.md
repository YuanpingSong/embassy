# Embassy release runbook (npm / GitHub)

Parameters the PM supplies: VERSION (x.y.z), the approved patch file (or
"main as-is"), changelog entry text, release-notes text.

Safety rules (binding on every step):
- Never move or reuse a tag. If the tag exists, stop.
- Never force-push. Never rewrite main history.
- A test failure is never retried or remediated — stop with the verbatim
  failing output. Only infrastructure 5xx/capacity errors are retryable.

Steps, in order — each gates the next:

1. Landing tree clean, on main, matching origin/main. If a patch is
   supplied: apply it; it must apply without fuzz.
2. Version pins, all four: `npm version VERSION --no-git-tag-version`
   (package.json + npm-shrinkwrap.json); `EMBASSY_VERSION` constant in
   `src/gateway/cli.ts`; the pinned version assertion in
   `test/gateway-cli.test.ts` ("package metadata" test). Then grep the
   tree for the previous version string — zero hits outside
   CHANGELOG.md, historical release notes, and lockfile-internal
   dependency entries, or stop and list each hit.
3. Insert the PM's CHANGELOG entry (top of list, existing format) and
   write `.github/release-notes/vVERSION.md` verbatim from the brief.
4. `TMPDIR=/tmp npm run check` IN THE LANDING TREE. Verify counts both
   directions: expected pass count printed, and 0 fail / 0 cancelled /
   0 skipped. Mismatch = stop with the counts.
5. Commit `Release vVERSION` (body from the brief), tag `vVERSION`,
   push main, then push the tag.
6. Watch the Release pipeline run to terminal state.
   - Infra 5xx on release-creation: `gh run rerun <id> --failed`, up to
     3 times, spaced 60s.
   - npm publish step SKIPPED after an otherwise green rerun:
     `gh workflow run release.yml -f tag=vVERSION`, then watch that run.
   - Any test-job failure: stop, verbatim output.
7. Verify from the outside: `gh release view vVERSION` exists and is not
   a draft; `npm view agent-embassy version` serves VERSION (allow up to
   two 30s propagation waits).
8. Report: tag, pipeline run id, npm version served, and the pass counts
   from step 4.

The runner never upgrades machines, restarts brokers, or runs live
drills — those are separate runbooks executed on PM instruction.
