// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Sitzung ↔ Anfrage: Cookie lesen, Cookies setzen/löschen, /api/ich, /api/abmelden, /api/sitzungen (Übersicht
// und Beenden – Ergänzung zum Vertrag, damit die Nutzerverwaltung „Sitzungen beenden“ anbieten kann).
// POST /api/sitzung/abmelden {minuten}: eigene Zeit bis zur automatischen Abmeldung (null = Standard, 0 = nie); /api/ich
// meldet sie als `abmelden` und erneuert die Cookies, damit dauerhafte Cookies mit jeder Nutzung weiterleben.

import { FahnasFehler } from '../gemeinsam/fehler.js';
import { cookies, cookieText, cookieAnhaengen, json, leseJson } from './server.js';
import { SITZUNG_COOKIE, GERAET_COOKIE, GERAET_MUSTER, COOKIE_DAUERHAFT_S, neueGeraeteKennung } from './sitzungen.js';
import { CSRF_COOKIE } from './csrf.js';
import { ipNormal, vertraut, clientIp } from './bremse.js';

/**
 * Wie erreicht der Browser den NAS? `ueber_proxy`: die Anfrage kam über einen Reverse-Proxy (der setzt X-Forwarded-For,
 * X-Real-IP oder Forwarded – ob er vertraut ist, spielt hier keine Rolle); `nas_adresse`: die Adresse des NAS, auf der die
 * Verbindung ankam (bei einem Proxy im Heimnetz dessen Ziel, z. B. 192.168.1.29). Die Apps-Ansicht öffnet Apps dann direkt
 * dort statt unter der Domain des Proxys, der nur die Oberfläche weiterreicht.
 */
function zugang(req) {
  if (!req) return { ueber_proxy: false, nas_adresse: null };
  const k = req.headers || {};
  return { ueber_proxy: !!(k['x-forwarded-for'] || k['x-real-ip'] || k.forwarded), nas_adresse: ipNormal(req.socket && req.socket.localAddress) || null };
}

export class Auth {
  /**
   * @param {{sitzungen: import('./sitzungen.js').Sitzungen, secure: boolean, systemKonfig: () => object, protokoll: object, ereignisse?: object}} o
   */
  constructor({ sitzungen, secure = true, systemKonfig = () => ({}), protokoll = null, ereignisse = null, linkAdresse = null, vertrauteProxys = () => null, extern = () => false }) {
    this.sitzungen = sitzungen; this.secure = secure; this.systemKonfig = systemKonfig; this.protokoll = protokoll; this.ereignisse = ereignisse;
    this.linkAdresse = linkAdresse; this.vertrauteProxys = vertrauteProxys; this.extern = extern;
  }

  /**
   * Sitzung aus dem Cookie der Anfrage (oder null). Eine zu Hause/per VPN ohne zweiten Faktor angemeldete Sitzung
   * (`totp_spaeter`), die mit einer Adresse aus dem Internet auftaucht, braucht ab jetzt den Code (totp_offen).
   */
  async sitzungAus(req) {
    const id = cookies(req).get(SITZUNG_COOKIE);
    if (!id) return null;
    const s = this.sitzungen.hole(id);
    if (s && s.totp_spaeter && !s.totp_offen && this.extern(clientIp(req, this.vertrauteProxys()))) {
      this.sitzungen.aktualisieren(s.id, { totp_offen: true });
      s.totp_offen = true;
      if (this.protokoll) this.protokoll.eintrag('totp_nachgefordert', { nutzer: s.nutzer, ip: clientIp(req, this.vertrauteProxys()) });
    }
    return s;
  }

  /** Gerätekennung aus dem Geräte-Cookie der Anfrage (oder null). */
  geraetAus(req) {
    const g = req ? cookies(req).get(GERAET_COOKIE) : null;
    return typeof g === 'string' && GERAET_MUSTER.test(g) ? g : null;
  }

  /**
   * Setzt Sitzungs- und CSRF-Cookie. Dauerhaft („angemeldet bleiben“ oder eigene Abmelde-Zeit) → Max-Age 400 Tage – wann
   * die Sitzung endet, entscheidet allein der Server; sonst Sitzungs-Cookie des Browsers. Dazu immer das Geräte-Cookie
   * (400 Tage); eine Sitzung ohne Gerät bekommt dabei die Kennung des Browsers (oder eine neue).
   */
  cookiesSetzen(res, sitzung, req = null) {
    const maxAge = this.sitzungen.dauerhaft(sitzung) ? COOKIE_DAUERHAFT_S : undefined;
    cookieAnhaengen(res, cookieText(SITZUNG_COOKIE, sitzung.id, { httpOnly: true, secure: this.secure, maxAge }));
    cookieAnhaengen(res, cookieText(CSRF_COOKIE, sitzung.csrf, { httpOnly: false, secure: this.secure, maxAge }));
    if (!sitzung.geraet) {
      const g = this.geraetAus(req) || neueGeraeteKennung();
      if (this.sitzungen.geraetBinden(sitzung.id, g)) sitzung.geraet = g;
    }
    if (sitzung.geraet) cookieAnhaengen(res, cookieText(GERAET_COOKIE, sitzung.geraet, { httpOnly: true, secure: this.secure, maxAge: COOKIE_DAUERHAFT_S }));
  }

  cookiesLoeschen(res) {
    cookieAnhaengen(res, cookieText(SITZUNG_COOKIE, '', { httpOnly: true, secure: this.secure, maxAge: 0 }));
    cookieAnhaengen(res, cookieText(CSRF_COOKIE, '', { httpOnly: false, secure: this.secure, maxAge: 0 }));
  }

  /** Meldet einen Nutzer an: Sitzung anlegen (ersetzt seine alte auf diesem Gerät), Cookies setzen. Gibt die Sitzung zurück. */
  anmelden(res, { nutzer, rolle, anzeigename, bleiben, ip, totp_offen, totp, totp_spaeter }, req = null) {
    const geraet = this.geraetAus(req) || neueGeraeteKennung();
    const s = this.sitzungen.anlegen({ nutzer, rolle, anzeigename, bleiben, ip, totp_offen, totp, totp_spaeter, geraet });
    this.cookiesSetzen(res, s, req);
    return s;
  }

  /** Antwort für /api/ich. */
  ich(sitzung, req = null) {
    const sys = this.systemKonfig() || {};
    const z = zugang(req);
    // Adresse für Freigabelinks: die öffentliche Domain, über die die Oberfläche zuletzt über einen vertrauten Proxy kam
    if (this.linkAdresse) {
      const liste = this.vertrauteProxys();
      const socketIp = ipNormal(req && req.socket && req.socket.remoteAddress);
      if (req && liste && socketIp && vertraut(liste, socketIp)) this.linkAdresse.lernen(req, true);
      z.link_basis = this.linkAdresse.wert || null;
    }
    return { name: sitzung.nutzer, anzeigename: sitzung.anzeigename || sitzung.nutzer, rolle: sitzung.rolle, totp: !!sitzung.totp, sprache: sys.sprache || 'de', design: sys.design || 'auto', zugang: z, abmelden: this.sitzungen.abmeldenVon(sitzung.nutzer) };
  }

  routen(router) {
    router.add('GET', '/api/ich', { sitzung: 'voll' }, (ctx) => {
      this.cookiesSetzen(ctx.res, ctx.sitzung, ctx.req);
      json(ctx.res, 200, { ok: true, ergebnis: this.ich(ctx.sitzung, ctx.req) });
    });

    // Eigene Zeit bis zur automatischen Abmeldung: {minuten: null|0|15|…} – gilt sofort für alle eigenen Sitzungen
    router.add('POST', '/api/sitzung/abmelden', { sitzung: 'voll', csrf: true }, async (ctx) => {
      const b = await leseJson(ctx.req);
      const minuten = b.minuten === null || b.minuten === undefined ? null : b.minuten;
      await this.sitzungen.abmeldenSetzen(ctx.sitzung.nutzer, minuten);
      this.cookiesSetzen(ctx.res, ctx.sitzung, ctx.req);
      if (this.protokoll) this.protokoll.eintrag('abmelden_zeit', { nutzer: ctx.sitzung.nutzer, minuten, ip: ctx.ip });
      json(ctx.res, 200, { ok: true, ergebnis: { abmelden: minuten } });
    });

    router.add('POST', '/api/abmelden', { sitzung: 'offen', csrf: true }, (ctx) => {
      this.sitzungen.loeschen(ctx.sitzung.id, 'abgemeldet');
      if (this.protokoll) this.protokoll.eintrag('abmeldung', { nutzer: ctx.sitzung.nutzer, ip: ctx.ip });
      this.cookiesLoeschen(ctx.res);
      json(ctx.res, 200, { ok: true, ergebnis: { abgemeldet: true } });
    });

    // Übersicht: Admin sieht alle, Nutzer nur eigene. Die eigene ist mit aktuell:true markiert.
    router.add('GET', '/api/sitzungen', { sitzung: 'voll' }, (ctx) => {
      const liste = this.sitzungen.liste(ctx.sitzung.rolle === 'admin' ? undefined : ctx.sitzung.nutzer)
        .map((s) => ({ ...s, aktuell: ctx.sitzung.id.startsWith(s.kennung) && s.nutzer === ctx.sitzung.nutzer }));
      json(ctx.res, 200, { ok: true, ergebnis: liste });
    });

    // Beenden: {nutzer} (Admin: alle Sitzungen dieses Nutzers), {kennung} (eigene oder Admin), {alle_anderen:true} (eigene außer dieser)
    router.add('POST', '/api/sitzungen/beenden', { sitzung: 'voll', csrf: true }, async (ctx) => {
      const b = await leseJson(ctx.req);
      let n = 0;
      if (b.alle_anderen === true) {
        n = this.sitzungen.loescheNutzer(ctx.sitzung.nutzer, ctx.sitzung.id, 'beendet');
      } else if (typeof b.kennung === 'string') {
        const id = this.sitzungen.idZuKennung(b.kennung, ctx.sitzung.rolle === 'admin' ? undefined : ctx.sitzung.nutzer);
        if (!id) throw new FahnasFehler('E_NICHT_GEFUNDEN', 'Sitzung nicht gefunden');
        n = this.sitzungen.loeschen(id, 'beendet') ? 1 : 0;
        if (id === ctx.sitzung.id) this.cookiesLoeschen(ctx.res);
      } else if (typeof b.nutzer === 'string') {
        if (ctx.sitzung.rolle !== 'admin' && b.nutzer !== ctx.sitzung.nutzer) throw new FahnasFehler('E_RECHTE', 'Nur Admins dürfen fremde Sitzungen beenden');
        n = this.sitzungen.loescheNutzer(b.nutzer, undefined, 'beendet');
        if (b.nutzer === ctx.sitzung.nutzer) this.cookiesLoeschen(ctx.res);
      } else {
        throw new FahnasFehler('E_PARAMS', 'Gib nutzer, kennung oder alle_anderen an', { feld: 'nutzer' });
      }
      if (this.protokoll) this.protokoll.eintrag('sitzungen_beendet', { durch: ctx.sitzung.nutzer, anzahl: n, ip: ctx.ip });
      json(ctx.res, 200, { ok: true, ergebnis: { beendet: n } });
    });
  }
}
