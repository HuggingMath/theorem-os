import { render } from 'preact';
import { useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { animateEntrance } from '../motion';
import { Icon } from './Icon';
import { t } from '../../i18n';

export type PaletteCommand = { id: string; group: string; label: string; hint?: string; icon: string; keywords?: string;
  /** Language of a label not written in the interface language, such as the language switch naming Chinese in Chinese. */
  lang?: string; run(): void };

const matches = (command: PaletteCommand, query: string) => {
  const text = `${command.label} ${command.hint ?? ''} ${command.keywords ?? ''}`.toLowerCase();
  return query.toLowerCase().split(/\s+/).filter(Boolean).every(word => text.includes(word));
};
/** 2 when the label holds the whole query as typed, 1 when the hint or keywords do, 0 when only its words match apart. */
const closeness = (command: PaletteCommand, query: string) => {
  const whole = query.trim().toLowerCase();
  if (!whole || command.label.toLowerCase().includes(whole)) return whole ? 2 : 0;
  return `${command.hint ?? ''} ${command.keywords ?? ''}`.toLowerCase().includes(whole) ? 1 : 0;
};

function Palette({ commands, session }: { commands: readonly PaletteCommand[]; session: number }) {
  const [query, setQuery] = useState(''), [index, setIndex] = useState(0);
  const dialog = useRef<HTMLDialogElement>(null), input = useRef<HTMLInputElement>(null), list = useRef<HTMLUListElement>(null);
  // One heading per group, in the order the groups first appear, however the commands were pushed. Within a group the
  // commands that hold the whole query come first, so 「第 17 题」 opens that run rather than the first with a 1 and a 7.
  const shown = useMemo(() => {
    const order = new Map<string, number>();
    for (const command of commands) if (!order.has(command.group)) order.set(command.group, order.size);
    return commands.filter(command => matches(command, query)).map((command, position) => ({ command, position, close: closeness(command, query) }))
      .sort((a, b) => order.get(a.command.group)! - order.get(b.command.group)! || b.close - a.close || a.position - b.position)
      .map(item => item.command);
  }, [commands, query]);
  const selected = Math.min(index, Math.max(0, shown.length - 1));
  useLayoutEffect(() => {
    const target = dialog.current!;
    setQuery(''); setIndex(0);
    if (!session || target.open) return;
    target.showModal(); animateEntrance(target, 'dialog'); input.current!.focus();
  }, [session]);
  useLayoutEffect(() => {
    list.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [selected, query]);
  const choose = (command: PaletteCommand | undefined) => {
    if (!command) return;
    dialog.current!.close();
    command.run();
  };
  const keydown = (event: KeyboardEvent) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (shown.length) setIndex((selected + (event.key === 'ArrowDown' ? 1 : shown.length - 1)) % shown.length);
    } else if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); choose(shown[selected]); }
  };
  let group = '';
  return <dialog ref={dialog} id="command-palette" class="command-palette" aria-label={t('命令面板')}
    onClick={event => { if (event.target === dialog.current) dialog.current!.close(); }}>
    <div class="palette-search"><Icon name="search" />
      <input ref={input} type="text" value={query} placeholder={t('搜索命令、研究记录或视图…')} aria-label={t('搜索命令')} role="combobox" aria-expanded="true"
        aria-controls="palette-options" aria-activedescendant={shown[selected] ? `palette-${shown[selected]!.id}` : undefined} autocomplete="off" spellcheck={false}
        onInput={event => { setQuery((event.target as HTMLInputElement).value); setIndex(0); }} onKeyDown={keydown} />
      <kbd>Esc</kbd></div>
    {/* The search box owns the keys (aria-activedescendant), so the scrolling list is not a Tab stop of its own. */}
    <ul ref={list} id="palette-options" class="palette-options" role="listbox" aria-label={t('可用命令')} tabIndex={-1}>
      {shown.map((command, position) => {
        const heading = command.group !== group ? (group = command.group) : '';
        return <li key={command.id} role="presentation">
          {heading && <p class="palette-group" aria-hidden="true">{heading}</p>}
          <button type="button" id={`palette-${command.id}`} role="option" tabIndex={-1} aria-selected={position === selected}
            onMouseMove={() => { if (position !== selected) setIndex(position); }} onClick={() => choose(command)}>
            <Icon name={command.icon} /><span class="palette-label" lang={command.lang}>{command.label}</span>{command.hint && <span class="palette-hint">{command.hint}</span>}
            {position === selected && <Icon name="corner-down-left" />}
          </button>
        </li>;
      })}
      {!shown.length && <li class="palette-empty" role="presentation">{t('没有匹配的命令')}</li>}
    </ul>
  </dialog>;
}

export function createCommandPalette(commands: () => readonly PaletteCommand[]) {
  const root = document.createElement('div');
  document.body.append(root);
  let session = 0;
  const draw = () => render(<Palette commands={session ? commands() : []} session={session} />, root);
  draw();
  return {
    dialog: root.querySelector<HTMLDialogElement>('#command-palette')!,
    open() { session++; draw(); },
  };
}
