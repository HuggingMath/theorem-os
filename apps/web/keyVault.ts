import crypto from 'node:crypto';
import type { WebSavedKey } from './shared';
import type { WebStorage } from './storage';

/**
 * API keys an account chose to keep, sealed with AES-256-GCM under THEOREMOS_WEB_KEY_SECRET, which lives in the service
 * environment and never in the data directory. Each seal is bound to the account, the provider and its address, so a
 * record copied to another account or a provider moved to a new address opens to nothing; the browser only ever gets
 * the last four characters.
 */
type Sealed = { baseUrl: string; iv: string; tag: string; data: string };
type VaultRecord = { providers: Record<string, Sealed> };

export class WebKeyVault {
  constructor(private readonly secret: Buffer, private readonly storage: WebStorage) {}

  private path(accountId: string) {
    return ['keys', `${crypto.createHash('sha256').update(accountId).digest('hex')}.json`];
  }
  private aad(accountId: string, providerId: string, baseUrl: string) {
    return Buffer.from(JSON.stringify(['theorem-os.web-key.v1', accountId, providerId, baseUrl]));
  }
  private read(accountId: string): VaultRecord {
    return this.storage.getRecord<VaultRecord>(this.path(accountId)) ?? { providers: {} };
  }
  private open(accountId: string, providerId: string, sealed: Sealed): string | undefined {
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', this.secret, Buffer.from(sealed.iv, 'base64'));
      decipher.setAAD(this.aad(accountId, providerId, sealed.baseUrl));
      decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
      return Buffer.concat([decipher.update(Buffer.from(sealed.data, 'base64')), decipher.final()]).toString('utf8');
    } catch { return undefined; }
  }

  /** The saved key for this provider at this address; a seal that no longer opens counts as none. */
  get(accountId: string, providerId: string, baseUrl: string): string | undefined {
    const sealed = this.read(accountId).providers[providerId];
    return sealed && sealed.baseUrl === baseUrl ? this.open(accountId, providerId, sealed) : undefined;
  }
  list(accountId: string, providers: { id: string; baseUrl: string }[]): WebSavedKey[] {
    return providers.flatMap(provider => {
      const key = this.get(accountId, provider.id, provider.baseUrl);
      return key ? [{ providerId: provider.id, ending: key.slice(-4) }] : [];
    });
  }
  save(accountId: string, providerId: string, baseUrl: string, key: string) {
    const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', this.secret, iv);
    cipher.setAAD(this.aad(accountId, providerId, baseUrl));
    const data = Buffer.concat([cipher.update(key, 'utf8'), cipher.final()]);
    const record = this.read(accountId);
    record.providers[providerId] = { baseUrl, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
    this.storage.saveRecord(this.path(accountId), record);
  }
  forget(accountId: string, providerId: string) {
    const record = this.read(accountId);
    if (!record.providers[providerId]) return;
    delete record.providers[providerId];
    if (Object.keys(record.providers).length) this.storage.saveRecord(this.path(accountId), record);
    else this.storage.deleteRecord(this.path(accountId));
  }
  forgetAccount(accountId: string) { this.storage.deleteRecord(this.path(accountId)); }
}
