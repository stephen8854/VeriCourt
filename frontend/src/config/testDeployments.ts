/**
 * Known throwaway StudioNet test deployments, used ONLY by the read-only live
 * check page. Not an application deployment: the app never writes to it.
 *
 * Phase 2.17C (docs/PHASE_2_17C_NO_REPLY_STUDIONET_REPORT.md): fictional
 * no-reply fixture, deployed by a throwaway account; all six transactions were
 * observed FINALIZED with MAJORITY_AGREE by the Python harness.
 *
 * Later writes, recorded in `laterWrites` (not part of the live check's
 * expectations in `transactions`, which still describe the Phase 2.17C run):
 * - Phase 3.5A Stage A added VC-000002 with a one-off guarded genlayer-js
 *   script (docs/PHASE_3_5A_STAGE_A_REPORT.md);
 * - Phase 3.6 added VC-000003 from a throwaway browser wallet through the gated
 *   write-experiment build (docs/PHASE_3_6_BROWSER_WALLET_TEST_REPORT.md);
 * - Phase 4.1 recorded VC-000003's missed reply deadline from the same wallet
 *   (docs/PHASE_4_1_LIVE_TEST_REVIEW.md).
 * The contract holds 3 cases after Phase 4.1.
 */

export interface KnownTransaction {
  operation: string;
  hash: `0x${string}`;
}

export interface TestDeployment {
  label: string;
  address: `0x${string}`;
  caseId: string;
  /** SHA-256 (hex) of contracts/vericourt.py as deployed; checked against the repo by a unit test. */
  expectedCodeSha256: string;
  deployTx: `0x${string}`;
  transactions: readonly KnownTransaction[];
  /** Writes made after the original run, by other phases (evidence only; not checked by the live page). */
  laterWrites: readonly LaterWrite[];
}

export interface LaterWrite {
  phase: string;
  operation: string;
  caseId: string;
  hash: `0x${string}`;
  /** Fresh single-use test account; its key existed only in the writing process. */
  sender: `0x${string}`;
  observed: string;
  report: string;
}

export const PHASE_2_17C_NO_REPLY: TestDeployment = {
  label: "Phase 2.17C no-reply test deployment (throwaway, fictional data)",
  address: "0x3258A80A86920792354A9b7e59D5Ed2409E96220",
  caseId: "VC-000001",
  expectedCodeSha256: "25bc9e0b2bae1a47a64a1324e54123ff132bf343d4a15d5be4e8f7d762e79333",
  deployTx: "0x4557895102ac3e4eded2d928745098c98b382fe7a9b13a3cbdc88f7219881567",
  transactions: [
    { operation: "deploy", hash: "0x4557895102ac3e4eded2d928745098c98b382fe7a9b13a3cbdc88f7219881567" },
    { operation: "create_case", hash: "0x35f1263e52886201adcd1860dd957fb4a2881d2fdecfe12727328e20002fdf28" },
    { operation: "submit_evidence (E1)", hash: "0xac06c3c9667ebbfd4e6d4ffc04994ffef21df73eb20a71b2dcccad9f52c2eaa1" },
    { operation: "submit_evidence (E2)", hash: "0x4c16b6982f942e7704216c54a1587ef90dc74ec9e9c19ef86704c2563e464b66" },
    { operation: "process_reply_deadline", hash: "0x395b74d6c9d1928c9cd1ac229a79ce8134c9ef11e0a146f3808c5a3eedb2ed7c" },
    { operation: "request_assessment", hash: "0xaf54746cdd8d48e04fc7d270dfd3d750678ddaf1eb0162196ee5d55247528122" },
  ],
  laterWrites: [
    {
      phase: "3.5A Stage A",
      operation: "create_case (fictional, via guarded genlayer-js 1.1.8 local-account path)",
      caseId: "VC-000002",
      hash: "0x309c83aab54b0408930d9c3e92a0f9037fd53a97928f5018ce8012c491487f09",
      sender: "0x96E2fb5A4FEa1532F14Cb70D495D55BAdd7426B0",
      observed: "2026-10-17: FINALIZED, MAJORITY_AGREE; latest-final get_case_count = 2; get_case(VC-000002) matched the intent",
      report: "docs/PHASE_3_5A_STAGE_A_REPORT.md",
    },
    {
      phase: "3.6 browser-wallet test",
      operation: "create_case (fictional, via the gated browser-wallet experiment and an operator's throwaway wallet)",
      caseId: "VC-000003",
      hash: "0x1574004493ed3f2bb5dd29d673d6738d2ee192379edfaa563d523f69d7c108e0",
      sender: "0x16fD571ae717F92b5e43597d813267C8d15f105A",
      observed: "2026-10-19: FINALIZED, MAJORITY_AGREE (3 agree, 2 idle); latest-final get_case_count = 3; get_case(VC-000003) matched the reviewed fields",
      report: "docs/PHASE_3_6_BROWSER_WALLET_TEST_REPORT.md",
    },
    {
      phase: "4.1 live test",
      operation: "process_reply_deadline (fictional case, via the gated browser-wallet experiment and an operator's throwaway wallet)",
      caseId: "VC-000003",
      hash: "0x7ce4c93288cb1fe33b2590c1525c3fba982c58e564f81872f4dbb92f92e6fde7",
      sender: "0x16fD571ae717F92b5e43597d813267C8d15f105A",
      observed: "2026-10-20: FINALIZED, MAJORITY_AGREE (3 agree, 2 idle); signed calldata equals the reviewed calldata; latest-final VC-000003 is NO_RESPONSE_BY_DEADLINE, locked, READY_FOR_ASSESSMENT",
      report: "docs/PHASE_4_1_LIVE_TEST_REVIEW.md",
    },
  ],
};
