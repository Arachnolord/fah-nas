// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// V4 Markdown-Darstellung (public/markdown.js): sicher (kein HTML, nur http/https/mailto), nur DOM-Aufbau.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { domAttrappe, alsText } from './dom_attrappe.js';

const HIER = path.dirname(fileURLToPath(import.meta.url));
const MD_PFAD = path.join(HIER, '..', '..', 'public', 'markdown.js');
let dom; let markdownZuKnoten;

before(async () => { dom = domAttrappe(); ({ markdownZuKnoten } = await import(pathToFileURL(MD_PFAD).href)); });
after(() => dom.aufraeumen());

const A = (href, text) => `<a href="${href}" rel="noopener noreferrer" target="_blank">${text}</a>`;

test('voll: Überschrift, Absatz, Formate', () => {
  assert.equal(alsText(markdownZuKnoten('# Titel\n\nText **fett** *kursiv* ~~weg~~ `code`')),
    '<h1>Titel</h1><p>Text <strong>fett</strong> <em>kursiv</em> <del>weg</del> <code>code</code></p>');
  assert.equal(alsText(markdownZuKnoten('### Drei ###\n__fett__ und _kursiv_')), '<h3>Drei</h3><p><strong>fett</strong> und <em>kursiv</em></p>');
});

test('HTML bleibt Text, gefährliche Links werden Text', () => {
  assert.equal(alsText(markdownZuKnoten('<b>x</b> [a](javascript:alert(1)) [b](https://x.de)')),
    `<p>&lt;b&gt;x&lt;/b&gt; [a](javascript:alert(1)) ${A('https://x.de', 'b')}</p>`);
  assert.equal(alsText(markdownZuKnoten('[m](mailto:a@b.de) [rel](/pfad)')), `<p>${A('mailto:a@b.de', 'm')} [rel](/pfad)</p>`);
});

test('Zeilenumbruch im Absatz wird <br>, Leerzeile trennt Absätze', () => {
  assert.equal(alsText(markdownZuKnoten('mmustermann\nsocialwave\n\nzweiter')), '<p>mmustermann<br>socialwave</p><p>zweiter</p>');
});

test('Listen, Aufgaben (deaktivierte Häkchen), verschachtelt', () => {
  assert.equal(alsText(markdownZuKnoten('- a\n- [x] b\n- [ ] c')),
    '<ul><li>a</li><li><input type="checkbox" checked disabled>b</li><li><input type="checkbox" disabled>c</li></ul>');
  assert.equal(alsText(markdownZuKnoten('1. eins\n2. zwei\n   - innen')), '<ol><li>eins</li><li>zwei<ul><li>innen</li></ul></li></ol>');
  assert.equal(alsText(markdownZuKnoten('3. drei\n4. vier')), '<ol start="3"><li>drei</li><li>vier</li></ol>');
});

test('Zitat, Codeblock, Linie, Tabelle', () => {
  assert.equal(alsText(markdownZuKnoten('> zitiert **fett**')), '<blockquote><p>zitiert <strong>fett</strong></p></blockquote>');
  assert.equal(alsText(markdownZuKnoten('```js\n<x> **nicht fett**\n```')), '<pre><code>&lt;x&gt; **nicht fett**</code></pre>');
  assert.equal(alsText(markdownZuKnoten('oben\n\n---\n\nunten')), '<p>oben</p><hr><p>unten</p>');
  assert.equal(alsText(markdownZuKnoten('| a | b |\n|---|:-:|\n| 1 | **2** |')),
    '<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td><strong>2</strong></td></tr></tbody></table>');
});

test('Escape und Autolinks mit Satzzeichen', () => {
  assert.equal(alsText(markdownZuKnoten('\\*kein\\* <https://a.de/x>')), `<p>*kein* ${A('https://a.de/x', 'https://a.de/x')}</p>`);
  assert.equal(alsText(markdownZuKnoten('siehe https://a.de/p.')), `<p>siehe ${A('https://a.de/p', 'https://a.de/p')}.</p>`);
});

test('chat: keine Überschriften, Zeilenumbrüche als <br>, Autolinks', () => {
  assert.equal(alsText(markdownZuKnoten('# nein\nzweite https://a.de', { modus: 'chat' })),
    `<p># nein<br>zweite ${A('https://a.de', 'https://a.de')}</p>`);
  assert.equal(alsText(markdownZuKnoten('- keine liste\n> kein zitat', { modus: 'chat' })), '<p>- keine liste<br>&gt; kein zitat</p>');
  assert.equal(alsText(markdownZuKnoten('```\ncode\n```', { modus: 'chat' })), '<pre><code>code</code></pre>');
});

test('leerer Text ergibt leeres Fragment', () => {
  assert.equal(alsText(markdownZuKnoten('')), '');
  assert.equal(alsText(markdownZuKnoten('\n\n')), '');
});

test('kein innerHTML in markdown.js', async () => {
  assert.equal(/innerHTML|insertAdjacentHTML|outerHTML/.test(await fs.readFile(MD_PFAD, 'utf8')), false);
});
