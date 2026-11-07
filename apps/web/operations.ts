import fs from 'node:fs';
import type { WebStorage } from './storage';

const maintenanceFile = ['operations', 'maintenance.json'];
/** Shared with the host operations CLI so maintenance does not require impersonating a user's login. */
export class WebOperations {
  private smtp = 0;
  private lastSmtpFailureAt?: string;
  constructor(private readonly storage: WebStorage, private readonly dataRoot?: string) {}
  get maintenance() { return this.storage.getRecord<{ enabled: boolean }>(maintenanceFile)?.enabled === true; }
  setMaintenance(enabled: boolean) {
    this.storage.saveRecord(maintenanceFile, { enabled, updatedAt: new Date().toISOString() });
  }
  mailFailed() { this.smtp++; this.lastSmtpFailureAt = new Date().toISOString(); }
  failures() { return { smtp: this.smtp, ...(this.lastSmtpFailureAt ? { lastSmtpFailureAt: this.lastSmtpFailureAt } : {}) }; }
  disk() {
    if (!this.dataRoot) return;
    fs.accessSync(this.dataRoot, fs.constants.W_OK);
    const stats = fs.statfsSync(this.dataRoot);
    return { availableBytes: stats.bavail * stats.bsize, totalBytes: stats.blocks * stats.bsize };
  }
  writable() {
    try { const disk = this.disk(); return !disk || disk.availableBytes >= 1024 ** 3; }
    catch { return false; }
  }
}
