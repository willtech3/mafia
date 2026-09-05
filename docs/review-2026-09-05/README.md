# Bug review and adversarial validation

## Confirmed and fixed

- **Vote-close race:** a local HTTP reproduction accepted a warning that nobody would be banished, then inserted a vote during elicitation. Previously the newly selected player was banished. `advance_phase` now carries phase, round, generation, and vote outcome into the atomic update; changed outcomes return CONFLICT without advancing. The widget sends the confirmation it displayed. Legacy callers capture an expectation at request entry.
- **Failed confirmation:** an interrupted/timed-out supported elicitation no longer silently closes voting. Only affirmative acceptance or an explicitly unsupported client proceeds.
- **Rules:** `how_to_play` now includes the complete rules in widget data, with or without a room. The app has a dedicated rules view instead of rendering the empty join state. Real MCP tests verify both payload forms.
- **Freshness:** visible widgets refresh by default, preserve unchanged DOM, retry failures with a status message, pause during typing/private reveal/frozen confirmations, and reject late responses from a previously viewed room.
- **Night readiness:** moderator-only aggregate counts remain available regardless of role or death. The night-close warning calls out missing actions.
- **Keyboard/accessibility:** role cards are buttons with concealed-face accessibility state, dialogs have labels and inert backgrounds, Tab wraps inside confirmations, Escape restores the opener, and toasts announce results. The board's Role button uses neutral artwork.

## Adversarial review and refutation

- **Client preflight alone closes the race:** refuted by a real vote inserted while server elicitation waits. The reducer check is necessary inside the store transaction.
- **Reject any vote-count change:** rejected as a false positive. More votes for the same sole leader do not change the promised banishment. A regression test explicitly permits them.
- **Phase alone is sufficient:** refuted by repeated advances and a reset/restart reaching the same phase. Round and generation are part of the confirmation.
- **All unavailable elicitation results mean consent:** refuted by a capable client throwing while confirming. Voting now stays open; the unsupported-client fallback remains compatible.
- **Readiness leaks secret targets:** refuted. The new field contains only submitted/total counts and is omitted for every non-moderator. Role/redaction tests cover all four moderator roles and death.
- **A returned projection is always current:** refuted by delayed replies after a host room switch. User actions and background reads now retain the current room.
- **Browser access failures prove app regressions:** rejected. Inspector/client blocking and a stalled browser tool are recorded as validation limitations; no security controls were weakened.

## Validation

- Full suite passed with 112 tests plus 9 Firestore tests skipped locally, including 2,000 randomized games and 49,151 invalid attempts rejected. Two later regressions (rules wire payload and late user response) were added and passed in the final 24-test targeted run; total now 114 non-emulator tests.
- Typecheck, app build, and production build pass. CI runs the Firestore emulator contract as well.
- Chrome local branch UI against real MCP handlers: keyboard role reveal, Enter to continue, target confirmation, Tab/Shift+Tab wrap, inert background attributes, Escape restoring the moderator button, and a saved doctor action changing readiness from 0/4 to 1/4.
- Signed-in Claude reproduced the deployed missing-rules baseline during the audit. Automatic approval review blocked disposable hosted room creation. The final branch rules browser check stalled and is not counted as passing; DOM and real MCP regression tests cover it.
- This PR is not a deployment. The original checkout was preserved; work was done in an isolated worktree.
