import { EvidencePanel } from "../components/EvidencePanel";
import { BeforeYouSubmit } from "../components/WriteConfirmation";
import { CONSENSUS_NOT_TRUTH, EXTERNAL_LINKS_CAN_CHANGE, FILE_HASH_NOTE, MISSING_RESPONSE_NOTE, REDACTION_NOTE } from "../contract/copy";
import { NOTICE_EXTERNAL_NOT_OPENED, NOTICE_NO_RESPONSE, STANDARD_NOTICES } from "../contract/notices";

export function Limitations() {
  return (
    <>
      <span className="kicker">Read before you submit</span>
      <h1>Limitations &amp; privacy</h1>

      <EvidencePanel title="Before you submit anything" tone="warning" headingLevel={2}>
        <p>
          Information written to a public blockchain may be visible to anyone and may be permanent. Do not submit
          passwords, private keys, seed phrases, confidential information, or personal data you do not have permission
          to share or do not need to share.
        </p>
        <p>
          Evidence referenced by the application (for example a link) may also be publicly accessible, depending on
          where and how it is stored. VeriCourt does not make anything private.
        </p>
      </EvidencePanel>

      <BeforeYouSubmit />

      <section className="section" aria-labelledby="evidence-notes">
        <h2 id="evidence-notes">Evidence, links and fingerprints</h2>
        <ul>
          <li>{REDACTION_NOTE}</li>
          <li>{EXTERNAL_LINKS_CAN_CHANGE}</li>
          <li>{FILE_HASH_NOTE}</li>
          <li>{MISSING_RESPONSE_NOTE}</li>
          <li>{CONSENSUS_NOT_TRUTH}</li>
        </ul>
      </section>

      <section className="section" aria-labelledby="evidence-limits">
        <h2 id="evidence-limits">What the contract can and cannot inspect</h2>
        <div className="grid">
          <EvidencePanel title="Links and files are not opened">
            <p>The contract states, verbatim:</p>
            <blockquote>{NOTICE_EXTERNAL_NOT_OPENED}</blockquote>
            <p>A file fingerprint (hash) is a reference only. The contract never sees the file itself.</p>
          </EvidencePanel>
          <EvidencePanel title="Party statements are not facts">
            <p>
              Text a party submits is that party's own account. The contract cannot tell a party's statement apart from
              a document, so an assessment's citations do not prove that an item is relevant or true.
            </p>
          </EvidencePanel>
          <EvidencePanel title="A missing reply is not proof">
            <p>When the respondent does not reply in time, the contract records, verbatim:</p>
            <blockquote>{NOTICE_NO_RESPONSE}</blockquote>
          </EvidencePanel>
        </div>
      </section>

      <section className="section" aria-labelledby="assessment-limits">
        <h2 id="assessment-limits">What an assessment is</h2>
        <ul>
          {STANDARD_NOTICES.map((notice) => (
            <li key={notice}>{notice}</li>
          ))}
          <li>
            Explanations, confidence levels, open questions, limitations and the remedy view are written by the
            leader's AI model and are not checked by validators.
          </li>
          <li>VeriCourt does not escrow or hold funds, pay anyone, issue refunds, or enforce any remedy.</li>
          <li>A recorded assessment is shown as final only after the network confirms it.</li>
        </ul>
      </section>
    </>
  );
}
