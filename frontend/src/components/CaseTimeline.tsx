import type { HistoryEntryView } from "../contract/types";
import { formatUtc, historyActionLabel } from "../display/caseText";
import { KNOWN_TRANSACTIONS_NOTE, type KnownTransaction } from "../cases/knownTransactions";

/** The contract's append-only case history, oldest first, plus the transaction IDs this app knows about. */
export function CaseTimeline({
  history,
  claimant,
  respondent,
  transactions,
}: {
  history: readonly HistoryEntryView[];
  claimant: string;
  respondent: string;
  transactions: readonly KnownTransaction[];
}) {
  const who = (actor: string) =>
    actor.toLowerCase() === claimant.toLowerCase() ? "claimant" : actor.toLowerCase() === respondent.toLowerCase() ? "respondent" : "other account";
  return (
    <div>
      <ol className="timeline">
        {history.map((h) => (
          <li key={h.seq} className="timeline__entry">
            <span className="timeline__time mono">{formatUtc(h.at)}</span>
            <strong>{historyActionLabel(h.action)}</strong>
            <span className="block hint">
              By the {who(h.actor)} <code className="break">{h.actor}</code>
            </span>
            {h.detail !== "" ? (
              <span className="block hint">
                Contract detail: <code className="break">{h.detail}</code>
              </span>
            ) : null}
          </li>
        ))}
      </ol>
      <h4>Transaction references</h4>
      <p className="hint">{KNOWN_TRANSACTIONS_NOTE}</p>
      {transactions.length === 0 ? (
        <p>No transaction IDs are known to this app for this case.</p>
      ) : (
        <ul>
          {transactions.map((t) => (
            <li key={t.hash}>
              <code>{t.operation}</code>: <code className="break">{t.hash}</code> <span className="hint">({t.source})</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
