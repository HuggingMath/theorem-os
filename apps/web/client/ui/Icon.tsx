import {
  Activity, ArrowLeft, ArrowUpRight, Blocks, Check, ChevronDown, CircleAlert, CircleCheck, Clock3, Copy, CopyPlus, CornerDownLeft, Download, FileCode2, FileJson2, Gauge, List, Network,
  PanelLeft, RefreshCw, Search, SlidersHorizontal, Square, SquarePen, Trash2, X, type IconNode,
} from 'lucide';

// Rendered as Preact elements so createIcons() never replaces nodes that Preact owns.
const named: Record<string, IconNode> = {
  activity: Activity, 'arrow-left': ArrowLeft, 'arrow-up-right': ArrowUpRight, blocks: Blocks, check: Check, 'chevron-down': ChevronDown, 'circle-alert': CircleAlert, 'circle-check': CircleCheck, 'clock-3': Clock3,
  copy: Copy, 'copy-plus': CopyPlus, 'corner-down-left': CornerDownLeft, download: Download, 'file-code-2': FileCode2, 'file-json-2': FileJson2,
  gauge: Gauge, list: List, network: Network, 'panel-left': PanelLeft, 'refresh-cw': RefreshCw, search: Search, 'sliders-horizontal': SlidersHorizontal,
  square: Square, 'square-pen': SquarePen, 'trash-2': Trash2, x: X,
};

export function Icon({ name }: { name: string }) {
  const node = named[name];
  if (!node) throw new Error(`Unknown workbench icon: ${name}`);
  return <svg class="lucide" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    {node.map(([tag, attrs], index) => { const Tag = tag as 'path'; return <Tag key={index} {...attrs as Record<string, string>} />; })}
  </svg>;
}

export const Spinner = () => <span class="spinner" />;
