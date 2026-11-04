import { taskDraftStorageKey } from './draft';
import { draftRecoveryStorageKey } from './draftRecovery';

export const draftOwnerStorageKey = 'theorem-os.web-draft-owner.v1';
export const submissionStorageKey = 'theorem-os.web-submission.v1';
const keys = [taskDraftStorageKey, draftRecoveryStorageKey, submissionStorageKey];
type StorageAccess = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** One owner per tab; unbound legacy drafts are discarded instead of assigned to the next login. */
export class OwnedDrafts {
  private owner?: string;
  constructor(private readonly storage: () => StorageAccess) {}
  bind(owner: string) {
    this.owner = owner;
    try {
      if (this.storage().getItem(draftOwnerStorageKey) !== owner) {
        for (const key of keys) this.storage().removeItem(key);
        this.storage().setItem(draftOwnerStorageKey, owner);
      }
    } catch { /* Editing still works without browser storage. */ }
  }
  clear() {
    this.owner = undefined;
    for (const key of [...keys, draftOwnerStorageKey]) {
      try { this.storage().removeItem(key); } catch { /* Revocation also disables in-memory writes. */ }
    }
  }
  getItem(key: string) {
    return this.owner && this.storage().getItem(draftOwnerStorageKey) === this.owner ? this.storage().getItem(key) : null;
  }
  setItem(key: string, value: string) {
    if (!this.owner || this.storage().getItem(draftOwnerStorageKey) !== this.owner) throw new Error('Draft owner unavailable');
    this.storage().setItem(key, value);
  }
  removeItem(key: string) { this.storage().removeItem(key); }
}
