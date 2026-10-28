/**
 * Minimal, dependency-free Markdown → HTML for the docs preview. Input is
 * HTML-escaped FIRST, then a safe subset (headings, bold/italic, inline code,
 * fenced code, links, unordered lists, paragraphs) is applied — so authored
 * content can never inject markup. Link URLs are restricted to http(s)/mailto/
 * relative. Good enough for internal runbooks/SOPs without a heavy library.
 * Output is unstyled HTML — render it inside a `.md-prose` container.
 */

function escapeHtml(s: string): string {
  // Quotes too: a `"` in a link URL must not be able to close the href
  // attribute and inject an event handler (stored XSS via a shared doc).
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function inline(s: string): string {
  // Split on inline code spans (delimiters kept) and transform only the
  // non-code segments, so emphasis/links never rewrite code content.
  return s
    .split(/(`[^`]+`)/g)
    .map((part) => {
      if (part.length >= 2 && part.startsWith('`') && part.endsWith('`')) {
        return `<code>${part.slice(1, -1)}</code>`;
      }
      return part
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/\*([^*]+)\*/g, '<em>$1</em>')
        .replace(/\b_([^_]+)_\b/g, '<em>$1</em>')
        .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, text: string, url: string) => {
          // http(s), mailto, or an in-app path — not `//host` / `/\host` (protocol-relative).
          const safe = /^(https?:\/\/|mailto:|\/(?![/\\]))/i.test(url) ? url : '#';
          return `<a href="${safe}" target="_blank" rel="noreferrer">${text}</a>`;
        });
    })
    .join('');
}

export function renderMarkdown(md: string): string {
  const lines = escapeHtml(md).split(/\r?\n/);
  const out: string[] = [];
  let inCode = false;
  let codeBuf: string[] = [];
  let listBuf: string[] = [];
  let paraBuf: string[] = [];

  const flushList = () => {
    if (listBuf.length) {
      out.push(`<ul>${listBuf.map((li) => `<li>${inline(li)}</li>`).join('')}</ul>`);
      listBuf = [];
    }
  };
  const flushPara = () => {
    if (paraBuf.length) {
      out.push(`<p>${paraBuf.map(inline).join('<br/>')}</p>`);
      paraBuf = [];
    }
  };
  const flushCode = () => {
    out.push(`<pre>${codeBuf.join('\n')}</pre>`);
    codeBuf = [];
  };

  for (const line of lines) {
    if (line.trim().startsWith('```')) {
      if (inCode) {
        flushCode();
        inCode = false;
      } else {
        flushPara();
        flushList();
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      codeBuf.push(line);
      continue;
    }

    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) {
      flushPara();
      flushList();
      const level = (h[1] ?? '#').length;
      out.push(`<h${level}>${inline(h[2] ?? '')}</h${level}>`);
      continue;
    }

    const li = /^[-*]\s+(.*)$/.exec(line);
    if (li) {
      flushPara();
      listBuf.push(li[1] ?? '');
      continue;
    }

    if (line.trim() === '') {
      flushPara();
      flushList();
      continue;
    }

    flushList();
    paraBuf.push(line);
  }

  if (inCode && codeBuf.length) flushCode();
  flushPara();
  flushList();
  return out.join('\n');
}
