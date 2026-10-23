import { Fragment, memo, useMemo, type ReactNode } from 'react';
import { api } from '../lib/bridge';
import { parseInline, parseMarkdown, type InlineToken } from '../lib/markdown';
import { CopyButton } from './ui';

function openLink(href: string): void {
  if (/^https?:\/\//i.test(href)) void api.app.openExternal(href);
  else void api.app.openPath(href);
}

function inlineNodes(tokens: InlineToken[]): ReactNode {
  return tokens.map((t, i) => {
    switch (t.kind) {
      case 'code':
        return (
          <code className="inline" key={i}>
            {t.text}
          </code>
        );
      case 'strong':
        return <strong key={i}>{inlineNodes(parseInline(t.text))}</strong>;
      case 'em':
        return <em key={i}>{inlineNodes(parseInline(t.text))}</em>;
      case 'link':
        return (
          <a
            key={i}
            href={t.href}
            onClick={(e) => {
              e.preventDefault();
              openLink(t.href);
            }}
          >
            {t.text}
          </a>
        );
      default:
        return <Fragment key={i}>{t.text}</Fragment>;
    }
  });
}

function textWithBreaks(text: string): ReactNode {
  const lines = text.split('\n');
  return lines.map((line, i) => (
    <Fragment key={i}>
      {i > 0 ? <br /> : null}
      {inlineNodes(parseInline(line))}
    </Fragment>
  ));
}

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  return (
    <div className="codeblock">
      <div className="codeblock-head">
        <span className="dots">
          <i />
          <i />
          <i />
        </span>
        <span className="lang">{lang}</span>
        <CopyButton text={code} label="复制代码" />
      </div>
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  );
}

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);

  return (
    <div className="md">
      {blocks.map((b, i) => {
        switch (b.kind) {
          case 'h': {
            const Tag = (`h${Math.min(b.level, 4)}` as 'h1' | 'h2' | 'h3' | 'h4');
            return <Tag key={i}>{inlineNodes(parseInline(b.text))}</Tag>;
          }
          case 'p':
            return <p key={i}>{textWithBreaks(b.text)}</p>;
          case 'ul':
            return (
              <ul key={i}>
                {b.items.map((it, j) => (
                  <li key={j}>{inlineNodes(parseInline(it))}</li>
                ))}
              </ul>
            );
          case 'ol':
            return (
              <ol key={i}>
                {b.items.map((it, j) => (
                  <li key={j}>{inlineNodes(parseInline(it))}</li>
                ))}
              </ol>
            );
          case 'quote':
            return (
              <blockquote key={i}>
                {b.text.split('\n').map((line, j) => (
                  <p key={j}>{inlineNodes(parseInline(line))}</p>
                ))}
              </blockquote>
            );
          case 'code':
            return <CodeBlock key={i} lang={b.lang} code={b.code} />;
          case 'table':
            return (
              <div className="table-wrap" key={i}>
                <table>
                  <thead>
                    <tr>
                      {b.head.map((h, j) => (
                        <th key={j}>{inlineNodes(parseInline(h))}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {b.rows.map((row, r) => (
                      <tr key={r}>
                        {b.head.map((_, c) => (
                          <td key={c}>{inlineNodes(parseInline(row[c] ?? ''))}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case 'hr':
            return <hr key={i} />;
          default:
            return null;
        }
      })}
    </div>
  );
});

export function StreamingCaret() {
  return <span className="thinking-caret" style={{ marginLeft: 3, verticalAlign: '-2px' }} />;
}
