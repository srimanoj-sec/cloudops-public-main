import { describe, expect, it } from 'vitest';
import { renderMarkdown } from './markdown';

/**
 * The preview is rendered with dangerouslySetInnerHTML, so these are security
 * tests: authored content must never produce live markup or script URLs.
 */
describe('renderMarkdown — injection safety', () => {
  it('escapes raw HTML instead of rendering it', () => {
    const html = renderMarkdown('<img src=x onerror=alert(1)><script>alert(2)</script>');
    expect(html).not.toMatch(/<img|<script/);
    expect(html).toContain('&lt;img');
  });

  it('neutralises javascript: and data: link targets', () => {
    for (const url of ['javascript:alert(1)', 'data:text/html,<b>x</b>', 'vbscript:x']) {
      const html = renderMarkdown(`[click](${url})`);
      expect(html).toContain('href="#"');
      expect(html).not.toMatch(/javascript:|vbscript:|data:text/);
    }
  });

  it('keeps safe links, opening them without referrer leakage', () => {
    const html = renderMarkdown('[docs](https://learn.microsoft.com) and [local](/inventory)');
    expect(html).toContain('href="https://learn.microsoft.com"');
    expect(html).toContain('href="/inventory"');
    expect(html).toContain('rel="noreferrer"');
  });

  it('cannot break out of an attribute with quotes in the URL', () => {
    const html = renderMarkdown('[x](https://a.com/"onmouseover="alert(1))');
    expect(html).not.toMatch(/"\s*onmouseover=/);
  });

  it('does not apply emphasis/links inside inline code', () => {
    const html = renderMarkdown('`**not bold** [not](a link)`');
    expect(html).toContain('<code>**not bold** [not](a link)</code>');
  });
});

describe('renderMarkdown — formatting', () => {
  it('renders headings, lists, bold and fenced code', () => {
    const html = renderMarkdown('# Runbook\n\n- step **one**\n- step two\n\n```\naz vm list\n```');
    expect(html).toContain('<h1>Runbook</h1>');
    expect(html).toContain('<li>step <strong>one</strong></li>');
    expect(html).toContain('<pre>az vm list</pre>');
  });
});
