import { render } from 'preact';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
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

function Palette({ commands, session }: { commands: readonly PaletteCommand[]; session: number }) {
  const [query, setQuery] = useState(''), [index, setIndex] = useState(0);
  const dialog = useRef<HTMLDialogElement>(null), input = useRef<HTMLInputElement>(null), list = useRef<HTMLUListElement>(null);
  const shown = commands.filter(command => matches(command, query));
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
    <ul ref={list} id="palette-options" class="palette-options" role="listbox" aria-label={t('可用命令')}>
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
