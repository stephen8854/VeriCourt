/** The contract's five public write methods (contracts/vericourt.py). Dependency-free so UI code can import it. */
export const CONTRACT_WRITE_METHODS = [
  "create_case",
  "submit_evidence",
  "submit_reply",
  "process_reply_deadline",
  "request_assessment",
] as const;
export type ContractWriteMethod = (typeof CONTRACT_WRITE_METHODS)[number];
