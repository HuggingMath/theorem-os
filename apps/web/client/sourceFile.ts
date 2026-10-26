import { t } from '../i18n';
export async function readLeanFile(file: Pick<File, 'name' | 'size' | 'arrayBuffer'>, maxBytes: number): Promise<string> {
  if (!/\.lean$/i.test(file.name)) throw new Error(t('请选择 .lean 文件'));
  if (file.size > maxBytes) throw new Error(t('源码超过 {0} KiB 上限', (maxBytes / 1024).toFixed(0)));
  const buffer = await file.arrayBuffer();
  if (buffer.byteLength > maxBytes) throw new Error(t('源码超过 {0} KiB 上限', (maxBytes / 1024).toFixed(0)));
  let source: string;
  try { source = new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
  catch { throw new Error(t('源码文件需使用 UTF-8 编码')); }
  if (!source.trim()) throw new Error(t('源码文件为空'));
  if (source.includes('\0')) throw new Error(t('源码文件包含无效字符'));
  return source;
}
