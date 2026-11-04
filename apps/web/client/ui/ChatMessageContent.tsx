import { Fragment, type ComponentChildren } from 'preact';
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { Marked, type Token, type Tokens, type TokenizerExtension } from 'marked';
import { render } from 'katex';
import { t } from '../../i18n';
import { leanTokens } from '../sourceText';
import { Icon } from './Icon';

type MathToken = { type: 'chat_math'; raw: string; text: string; display: boolean; closed: boolean };

function mathToken(source: string, block: boolean): MathToken | undefined {
  const opening = (block ? /^ {0,3}(\$\$|\\\[)/u : /^(\$\$|\$(?!\s)|\\\(|\\\[)/u).exec(source);
  if (!opening) return;
  const delimiter = opening[1], closing = delimiter === '\\(' ? '\\)' : delimiter === '\\[' ? '\\]' : delimiter;
  const display = delimiter === '$$' || delimiter === '\\[';
  let offset = opening[0].length;
  while ((offset = source.indexOf(closing, offset)) >= 0) {
    let escapes = 0;
    for (let at = offset - 1; at >= 0 && source[at] === '\\'; at--) escapes++;
    if (escapes % 2 === 0 && (delimiter !== '$' || !/\d/u.test(source[offset + 1] ?? ''))) {
      return { type: 'chat_math', raw: source.slice(0, offset + closing.length),
        text: source.slice(opening[0].length, offset), display, closed: true };
    }
    offset += closing.length;
  }
  // An unfinished stream remains readable, then becomes a formula when its delimiter arrives.
  return { type: 'chat_math', raw: source, text: source.slice(opening[0].length), display, closed: false };
}
const mathExtensions: TokenizerExtension[] = [
  { name: 'chat_math', level: 'block', start: source => source.search(/(?:^|\n) {0,3}(?:\$\$|\\\[)/u),
    tokenizer: source => mathToken(source, true) },
  { name: 'chat_math', level: 'inline', start: source => source.search(/\$|\\[([]/u),
    tokenizer: source => mathToken(source, false) },
];
const markdown = new Marked({ gfm: true, breaks: true, extensions: mathExtensions });

// Marked leaves the HTML-sensitive entities escaped for its string renderer. Here they become text nodes.
const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };
const plain = (text: string) => text.replace(/&(amp|lt|gt|quot|apos|nbsp);/gu, (_, name: string) => entities[name]);
function safeLink(href: string): string | undefined {
  const value = plain(href).trim();
  return /^(?:https?:\/\/|mailto:|\/(?![\/\\])|#)/iu.test(value) && !/[\u0000-\u0020\u007f]/u.test(value) ? value : undefined;
}

function Formula({ token }: { token: MathToken }) {
  const element = useRef<HTMLSpanElement>(null);
  const [failed, setFailed] = useState<string>();
  const rendered = token.closed && failed !== token.text;
  useLayoutEffect(() => {
    if (!rendered || !element.current) return;
    try {
      // KaTeX builds the formula as DOM nodes; no HTML string is parsed, and model HTML stays literal text below.
      render(token.text, element.current, { displayMode: token.display, throwOnError: true,
        trust: false, strict: 'ignore', maxSize: 20, maxExpand: 1000, output: 'htmlAndMathml' });
    } catch {
      element.current.textContent = '';
      setFailed(token.text);
    }
  }, [rendered, token.text, token.display]);
  const className = 'chat-math' + (token.display ? ' chat-math-display' : '');
  return rendered ? <span ref={element} class={className} />
    : <span class={className + ' chat-math-source'}>{token.raw}</span>;
}

function highlightedLean(source: string): ComponentChildren[] {
  const parts: ComponentChildren[] = [];
  let offset = 0;
  for (const token of leanTokens(source)) {
    if (token.start > offset) parts.push(source.slice(offset, token.start));
    parts.push(<span key={token.start} class={'lean-' + token.kind}>{source.slice(token.start, token.end)}</span>);
    offset = token.end;
  }
  if (offset < source.length) parts.push(source.slice(offset));
  return parts;
}

const previewLines = 18;
function CodeBlock({ token }: { token: Tokens.Code }) {
  const [expanded, setExpanded] = useState(false), [copied, setCopied] = useState<'idle' | 'copied' | 'failed'>('idle');
  const id = useId();
  const language = token.lang?.trim().split(/\s/u)[0] || '';
  const lines = token.text.split('\n'), long = lines.length > previewLines;
  const visible = long && !expanded ? lines.slice(0, previewLines).join('\n') : token.text;
  const source = useMemo(() => /^(?:lean|lean4)$/iu.test(language) ? highlightedLean(visible) : visible, [visible, language]);
  useEffect(() => { setCopied('idle'); }, [token.text]);
  useEffect(() => {
    if (copied !== 'copied') return;
    const timer = setTimeout(() => setCopied('idle'), 1800);
    return () => clearTimeout(timer);
  }, [copied]);
  async function copy() {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(token.text);
      setCopied('copied');
    } catch { setCopied('failed'); }
  }
  return <section class="chat-code" data-expanded={expanded} aria-label={language || t('代码')}>
    <header class="chat-code-header"><span>{language || t('代码')}</span>
      <button type="button" data-chat-code-copy onClick={() => void copy()} title={t('复制代码')}
        aria-label={copied === 'copied' ? t('代码已复制') : t('复制代码')}><Icon name={copied === 'copied' ? 'check' : 'copy'} />
        <span>{copied === 'copied' ? t('代码已复制') : t('复制代码')}</span></button>
    </header>
    <pre id={id} tabIndex={0}><code>{source}</code></pre>
    {long && <button type="button" class="chat-code-toggle" data-chat-code-toggle aria-expanded={expanded} aria-controls={id}
      onClick={() => setExpanded(value => !value)}><Icon name={expanded ? 'chevron-up' : 'chevron-down'} />
      {expanded ? t('收起') : t('展开全部 {0} 行', lines.length)}</button>}
    {copied === 'failed' && <p class="chat-code-copy-error" role="status">{t('复制失败，请选择代码复制。')}</p>}
  </section>;
}

function Inline({ tokens }: { tokens: Token[] }): preact.JSX.Element {
  return <>{tokens.map((token, index) => <Fragment key={index}>{renderToken(token)}</Fragment>)}</>;
}
function renderToken(token: Token): ComponentChildren {
  switch (token.type) {
    case 'chat_math': return <Formula token={token as MathToken} />;
    case 'space': case 'def': return null;
    case 'code': return <CodeBlock token={token as Tokens.Code} />;
    case 'heading': {
      const heading = token as Tokens.Heading, Tag = ('h' + Math.min(heading.depth + 1, 6)) as 'h2';
      return <Tag><Inline tokens={heading.tokens} /></Tag>;
    }
    case 'paragraph': return <p><Inline tokens={(token as Tokens.Paragraph).tokens} /></p>;
    case 'blockquote': return <blockquote><Inline tokens={(token as Tokens.Blockquote).tokens} /></blockquote>;
    case 'strong': return <strong><Inline tokens={(token as Tokens.Strong).tokens} /></strong>;
    case 'em': return <em><Inline tokens={(token as Tokens.Em).tokens} /></em>;
    case 'del': return <del><Inline tokens={(token as Tokens.Del).tokens} /></del>;
    case 'codespan': return <code class="chat-inline-code">{(token as Tokens.Codespan).text}</code>;
    case 'br': return <br />;
    case 'hr': return <hr />;
    case 'text': case 'escape': {
      const text = token as Tokens.Text;
      return text.tokens ? <Inline tokens={text.tokens} /> : plain(text.text);
    }
    case 'html': return <span class="chat-literal-html">{token.raw}</span>;
    case 'link': case 'image': {
      const link = token as Tokens.Link | Tokens.Image, href = safeLink(link.href);
      const content = link.tokens?.length ? <Inline tokens={link.tokens} /> : plain(link.text);
      // Images remain descriptive links, so messages cannot trigger remote resource loads.
      return href ? <a href={href} title={link.title || undefined} target="_blank" rel="noopener noreferrer">{content}</a> : content;
    }
    case 'list': {
      const list = token as Tokens.List;
      const items = list.items.map((item, index) => <li key={index} class={item.task ? 'chat-task-list-item' : undefined}>
        {item.task && <input type="checkbox" checked={!!item.checked} disabled aria-label={plain(item.text)} />}
        <Inline tokens={item.tokens} /></li>);
      return list.ordered ? <ol start={list.start || 1}>{items}</ol> : <ul>{items}</ul>;
    }
    case 'table': {
      const table = token as Tokens.Table;
      return <div class="chat-markdown-table" tabIndex={0}><table><thead><tr>{table.header.map((cell, index) =>
        <th key={index} scope="col" style={{ textAlign: table.align[index] || undefined }}><Inline tokens={cell.tokens} /></th>)}</tr></thead>
        <tbody>{table.rows.map((row, index) => <tr key={index}>{row.map((cell, column) =>
          <td key={column} style={{ textAlign: table.align[column] || undefined }}><Inline tokens={cell.tokens} /></td>)}</tr>)}</tbody></table></div>;
    }
    default: return token.raw;
  }
}

/** Display-only: messages stay unchanged in conversation storage, including unfinished streamed text. */
export function ChatMessageContent({ text }: { text: string }) {
  const tokens = useMemo(() => markdown.lexer(text), [text]);
  return <div class="chat-message-content" data-chat-markdown translate={false}><Inline tokens={tokens} /></div>;
}
