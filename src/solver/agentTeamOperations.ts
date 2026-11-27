import type { AgentTeamState } from './agentTeamState';

type OperationReceipt = AgentTeamState['operations'][number];

/** One index for both callers. The append-only array remains the checkpoint format. */
export class AgentTeamOperations {
  private readonly byKey = new Map<string, OperationReceipt>();

  constructor(private readonly receipts: OperationReceipt[]) {
    for (const receipt of receipts) {
      // Match the old find() behavior for checkpoints with repeated keys.
      if (!this.byKey.has(receipt.key)) this.byKey.set(receipt.key, receipt);
    }
  }

  get(key: string): OperationReceipt | undefined { return this.byKey.get(key); }

  append(receipt: OperationReceipt): void {
    this.receipts.push(receipt);
    if (!this.byKey.has(receipt.key)) this.byKey.set(receipt.key, receipt);
  }
}
