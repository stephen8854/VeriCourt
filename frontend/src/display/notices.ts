/**
 * Response notices. The contract's own text is returned verbatim; nothing here
 * paraphrases it or describes a missing reply as anything other than a
 * procedural fact.
 */
import { NOTICE_NO_RESPONSE } from "../contract/notices";

/** True only for the contract's explicit no-response state. `PENDING` is not a missed deadline. */
export function isNoResponse(responseState: unknown): boolean {
  return responseState === "NO_RESPONSE_BY_DEADLINE";
}

/** The contract's exact no-response notice when it applies, otherwise null. */
export function noResponseNotice(responseState: unknown): string | null {
  return isNoResponse(responseState) ? NOTICE_NO_RESPONSE : null;
}

export interface StoredNoticeCheck {
  /** Notices exactly as stored by the contract, to be shown verbatim and in order. */
  notices: readonly string[];
  /** Set when the stored notices do not contain the notice the response state requires. */
  mismatch: string | null;
}

/** Pass stored notices through unchanged and flag a missing no-response notice instead of inventing one. */
export function checkStoredNotices(notices: readonly string[], responseState: unknown): StoredNoticeCheck {
  const required = noResponseNotice(responseState);
  const mismatch =
    required !== null && !notices.includes(required)
      ? "The stored assessment does not contain the contract's no-response notice. Showing the stored notices unchanged."
      : null;
  return { notices: [...notices], mismatch };
}
