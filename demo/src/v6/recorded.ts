// Verbatim reviewed-fixture take; host suffixes and references are masked.
// Source frames and row ranges: demo/out/v6-footage/panels.json.
export const question = 'Can you review my change to the login flow and tell me the biggest risk?';
export const reply = 'The biggest risk is that issueSession now runs before second-factor verification, so a failed second factor still causes session issuance. This function does not return that session on rejection, but any persistent session or other side effects from issueSession remain, with no cleanup shown. Move session issuance back after successful second-factor verification so both factors must pass before a session is created.';
export const recorded = {
  send: "!  printf '%s\\n' 'Can you review my change to the login flow and tell me the biggest risk?' |\n  embassy send --to codex-reviewer@…",
  codexArrival: [
    '› <cross-session-message from-name="embassy-demo@…" conversation="conv_[redacted]">',
    '  <embassy-reply-hint conversation="conv_[redacted]" reply-as="codex-reviewer@…" from-provider="claude">Reply by running `embassy send --conversation conv_[redacted]` with the reply body on stdin. Caller, conversation, and route policy are rechecked.</embassy-reply-hint>',
    `  ${question}`, '', '  </cross-session-message>', '', '• Working (0s • esc to interrupt)',
  ],
  codexAnswer: [
    "• Ran embassy send --conversation conv_[redacted] <<'MESSAGE'",
    '  │ The biggest risk is that issueSession now runs before second-factor verification, so a failed',
    '  │ second factor still causes session issuance. This function does not return that session on',
    '  │ … +4 lines',
    '  └ {"ok":true,"command":"send","result":',
    '    {"accepted":true,"conversationId":"conv_[redacted]","deliveryToken":"dlv_oLCZOFRpsKjftYd1NI3T7VvR"}}',
    '', '◦ Working (19s • esc to interrupt)',
  ],
  replyCommand: "• Ran embassy send --conversation conv_[redacted] <<'MESSAGE'",
  claudeArrival: [
    '› Message from @codex-reviewer-…: <embassy-reply-hint conversation="conv_[redacted]" reply-as="embassy-demo@…" from-provider="c…',
    '(ctrl+o to expand)', '', '· Creating…',
  ],
  claudeExpanded: [
    '@ codex-reviewer@…❯',
    '  <embassy-reply-hint conversation="conv_[redacted]" reply-as="embassy-demo@…" from-provider="codex">Reply by running embassy send --conversation conv_[redacted] with the reply body on stdin. Caller, conversation, and route policy are rechecked.</embassy-reply-hint>',
    reply,
    '',
    '08:31 PM claude-haiku-4-5-20251001',
    '⏺ Acknowledged. The risk is real: issuing a session before second-factor verification succeeds leaves persistent side effects if MFA fails, breaking the security guarantee that both factors must pass before session creation. Moving session issuance after successful verification is the right fix.',
  ],
  ledger: [
    '>   42s ago delivered    codex-reviewer@… -> embassy-demo@…',
    '     1m ago delivered    embassy-demo@… -> codex-reviewer@…',
  ],
} as const;
