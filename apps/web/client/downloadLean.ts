import { leanFileName } from './leanOutline';

/** The compiled statement is available before semantic review or proof acceptance. */
export function downloadLean(source: string) {
  const url = URL.createObjectURL(new Blob([source], { type: 'text/plain;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url; link.download = leanFileName(source, '-problem');
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
