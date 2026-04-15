// ─── Feature Flags ────────────────────────────────────────────────────────────
// To restrict a feature to paid subscribers, flip its value to false and push
// a release. The UI will automatically show a locked "Pro" state instead of
// the live feature — no other code changes needed.
//
// To re-enable, flip back to true and push another release.

export const FEATURES = Object.freeze({
  BATCH_SCAN: true,   // Batch receipt scanning (paid feature — lock by setting false)
});
