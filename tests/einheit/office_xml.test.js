// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// XML im Browser (Plan 05 Aufgabe 6, V17): Präfixe bleiben im Namen, Entitäten und CDATA, Leerzeichen bleiben (w:t),
// keine DTD-Auswertung (keine externen oder eigenen Entitäten), Schutz vor zu tiefer Verschachtelung, Escape fürs Schreiben.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HIER = path.dirname(fileURLToPath(import.meta.url));
const { xmlLesen, xmlText, xmlEscape, kind, kinder } = await import(pathToFileURL(path.join(HIER, '..', '..', 'public', 'office', 'format', 'xml.js')).href);

test('Präfixe, Attribute, Entitäten, CDATA, Leerzeichen bleiben', () => {
  const w = xmlLesen('<?xml version="1.0"?><w:p a="1 &amp; 2"><w:t xml:space="preserve"> a &lt;b&gt; &#x263A; </w:t><w:t><![CDATA[<x>]]></w:t></w:p>');
  assert.equal(w.name, 'w:p'); assert.equal(w.attribute.a, '1 & 2');
  assert.deepEqual(w.kinder.map((k) => k.text), [' a <b> ☺ ', '<x>']); assert.equal(xmlText(w), ' a <b> ☺ <x>');
  assert.equal(w.kinder[0].attribute['xml:space'], 'preserve');
});

test('DTD wird nicht ausgewertet, unbekannte Entität bleibt Text', () => {
  const w = xmlLesen('<!DOCTYPE r [<!ENTITY x "BOOM"><!ENTITY y SYSTEM "file:///etc/passwd">]><r>&x;&y;</r>');
  assert.equal(w.text, '&x;&y;');
  assert.equal(xmlLesen('<!DOCTYPE html><r>a</r>').text, 'a');
});

test('Zeichenreferenzen, BOM, Kommentare, selbstschließende Elemente', () => {
  const w = xmlLesen('﻿<!-- Kopf --><r x=\'&quot;q&quot;\'>&#65;&#x110000;&#xD800;<leer/><k>1</k><k>2</k></r>');
  assert.equal(w.text, 'A&#x110000;&#xD800;'); assert.equal(w.attribute.x, '"q"');
  assert.equal(kind(w, 'leer').kinder.length, 0); assert.equal(kind(w, 'fehlt'), null);
  assert.deepEqual(kinder(w, 'k').map((k) => k.text), ['1', '2']);
});

test('kaputt → xml_kaputt; zu tief → xml_kaputt', () => {
  for (const s of ['<a><b></a>', '<a', '', '<a x=1/>', '   ', '<a></b>', '<!-- offen', '<a><![CDATA[x</a>']) assert.throws(() => xmlLesen(s), /xml_kaputt/, s);
  assert.throws(() => xmlLesen('<a>'.repeat(300) + '</a>'.repeat(300)), /xml_kaputt/);
  assert.doesNotThrow(() => xmlLesen('<a>'.repeat(200) + '</a>'.repeat(200)));
  assert.throws(() => xmlLesen(42), /xml_kaputt/);
});

test('xmlEscape', () => {
  assert.equal(xmlEscape(`a<&>"'\u0001b`), 'a&lt;&amp;&gt;&quot;&apos;b');
  assert.equal(xmlEscape('Tab\tZeile\nWagen\r'), 'Tab\tZeile\nWagen\r');
  assert.equal(xmlEscape(5), '5');
});
