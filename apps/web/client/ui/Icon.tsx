import {
  Activity, ArrowDown, ArrowLeft, Circle, CircleDashed, CircleDot, ArrowLeftRight, ArrowRight, ArrowUp, ArrowUpRight, BookOpen, CircleHelp, Eye, Play, Bell, BellOff, BellRing, Blocks, Check, CheckCheck, ChevronDown, ChevronRight, ChevronUp, CircleAlert, Languages, CircleCheck, Clock3, Copy, CopyPlus, CornerDownLeft, Hourglass, Download, EyeOff, FileCode2, FileJson2, Gauge, KeyRound, List, MessageCircleQuestion, MessageSquare, Network, Share2,
  Moon, PanelLeft, PanelRight, Send, RefreshCw, RotateCcw, Route, Search, SlidersHorizontal, Square, SquarePen, Sun, SunMoon, Trash2, TriangleAlert, UserRound, Users, X, Cpu, Ellipsis, GitBranch, GitBranchPlus, ListOrdered, ListTree, LocateFixed, GitCompare, Plus, ShieldCheck, type IconNode,
  Archive, Brain, ChevronLeft, FileMinus, FilePen, FilePlus, FileSearch, FolderOpen, Globe, Image, ListChecks, MessageSquareText, Server, Terminal, Wrench,
} from 'lucide';

// Rendered as Preact elements so createIcons() never replaces nodes that Preact owns.
const named: Record<string, IconNode> = {
  activity: Activity, 'arrow-down': ArrowDown, circle: Circle, 'circle-dashed': CircleDashed, 'circle-dot': CircleDot, 'arrow-left': ArrowLeft, 'arrow-left-right': ArrowLeftRight, 'arrow-right': ArrowRight, 'arrow-up': ArrowUp, 'arrow-up-right': ArrowUpRight, 'book-open': BookOpen, 'circle-help': CircleHelp, eye: Eye, play: Play, bell: Bell, 'bell-off': BellOff, 'bell-ring': BellRing, blocks: Blocks, check: Check, 'check-check': CheckCheck, 'chevron-down': ChevronDown, 'chevron-right': ChevronRight, 'chevron-up': ChevronUp, 'circle-alert': CircleAlert, 'circle-check': CircleCheck, 'clock-3': Clock3,
  copy: Copy, 'copy-plus': CopyPlus, 'corner-down-left': CornerDownLeft, download: Download, 'eye-off': EyeOff, hourglass: Hourglass, 'file-code-2': FileCode2, 'file-json-2': FileJson2,
  gauge: Gauge, 'key-round': KeyRound, languages: Languages, list: List, 'message-circle-question': MessageCircleQuestion, 'message-square': MessageSquare, moon: Moon, network: Network, 'panel-left': PanelLeft, 'panel-right': PanelRight, send: Send, 'refresh-cw': RefreshCw, 'rotate-ccw': RotateCcw, route: Route, search: Search, 'share-2': Share2, 'sliders-horizontal': SlidersHorizontal,
  cpu: Cpu, ellipsis: Ellipsis, 'git-branch': GitBranch, 'git-branch-plus': GitBranchPlus, 'list-ordered': ListOrdered, 'list-tree': ListTree, 'git-compare': GitCompare, 'locate-fixed': LocateFixed, plus: Plus, 'shield-check': ShieldCheck,
  square: Square, 'square-pen': SquarePen, sun: Sun, 'sun-moon': SunMoon, 'trash-2': Trash2, 'triangle-alert': TriangleAlert, 'user-round': UserRound, users: Users, x: X,
  // The route map's Agent actions.
  archive: Archive, brain: Brain, 'chevron-left': ChevronLeft, 'file-minus': FileMinus, 'file-pen': FilePen, 'file-plus': FilePlus, 'file-search': FileSearch,
  'folder-open': FolderOpen, globe: Globe, image: Image, 'list-checks': ListChecks, 'message-square-text': MessageSquareText, server: Server, terminal: Terminal, wrench: Wrench,
};

/** Every name Icon accepts; the component preview lists them. */
export const iconNames = Object.keys(named);

export function Icon({ name }: { name: string }) {
  const node = named[name];
  if (!node) throw new Error(`Unknown workbench icon: ${name}`);
  return <svg class="lucide" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    {node.map(([tag, attrs], index) => { const Tag = tag as 'path'; return <Tag key={index} {...attrs as Record<string, string>} />; })}
  </svg>;
}

export const Spinner = () => <span class="spinner" />;
