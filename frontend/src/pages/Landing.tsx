import { EvidencePanel } from "../components/EvidencePanel";

export function Landing() {
  return (
    <>
      <span className="kicker">Structured disputes about digital work</span>
      <h1>Evidence in. A structured, reasoned assessment out.</h1>
      <p className="lede">
        VeriCourt helps a client and a freelancer set out a disagreement about digital work: what was agreed, what
        was delivered, and the evidence each side has. A GenLayer Intelligent Contract then produces an AI-assisted
        assessment of that record, accepted only if independent validators agree on its decision fields.
      </p>
      <div className="actions">
        <a className="button" href="#/app">
          Open the case dashboard
        </a>
        <a className="button button--secondary" href="#/limitations">
          Read the limitations first
        </a>
      </div>

      <div className="grid">
        <EvidencePanel title="1. Define the dispute">
          <p>The claimant records the agreement, the expected deliverable, the claim, the requested remedy and up to five issues.</p>
        </EvidencePanel>
        <EvidencePanel title="2. Exchange evidence">
          <p>
            Both parties submit bounded evidence references. The respondent has a reply window. A missing reply is
            recorded as a procedural fact only.
          </p>
        </EvidencePanel>
        <EvidencePanel title="3. Inspect the assessment">
          <p>
            Each issue gets a determination with the evidence it cites. Explanations written by the AI are shown
            separately and marked as not independently verified.
          </p>
        </EvidencePanel>
      </div>

      <section className="section" aria-labelledby="what-it-is-not">
        <h2 id="what-it-is-not">What VeriCourt is not</h2>
        <div className="grid">
          <EvidencePanel title="Not a legal judgment" tone="warning">
            <p>
              Assessments are AI-assisted. They are not legal advice, a court judgment or a binding arbitration
              award, and validator agreement is not a guarantee of objective truth.
            </p>
          </EvidencePanel>
          <EvidencePanel title="No money moves" tone="warning">
            <p>
              VeriCourt does not escrow or hold funds, pay anyone, issue refunds, or enforce any remedy. A remedy view
              in an assessment is advisory only.
            </p>
          </EvidencePanel>
          <EvidencePanel title="Public by design" tone="warning">
            <p>
              Case data written to the blockchain may be public and permanent. Do not submit passwords, private keys or
              personal information you do not need to share.
            </p>
          </EvidencePanel>
        </div>
      </section>
    </>
  );
}
