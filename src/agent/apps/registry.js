// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// App-Updates erkennen wie Unraid („Update bereit“): Digest des Tags in der Registry (HEAD auf /v2/<repo>/manifests/<tag>,
// Kopfzeile Docker-Content-Digest) mit den RepoDigests des lokalen Images vergleichen. Nichts wird geladen – ein HEAD
// zählt bei Docker Hub nicht gegen das Abruf-Limit. Anonyme Registry-Anmeldung über den Bearer-Hinweis der 401-Antwort
// (Docker Hub, ghcr.io, lscr.io, quay.io …). Lokal gebaute Images (ohne RepoDigest) und per Digest festgenagelte
// Images haben kein Update.

const DOCKER_HUB = 'registry-1.docker.io';
const ACCEPT = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.docker.distribution.manifest.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
].join(', ');
const ZEITLIMIT_MS = 15_000;

/**
 * Image-Angabe zerlegen wie docker: „nginx“ → docker.io/library/nginx:latest, „ghcr.io/a/b:1“ → ghcr.io / a/b / 1.
 * @returns {{registry:string, repo:string, tag:string|null, digest:string|null, name:string}|null} name = Repo-Name, wie
 *   er in RepoDigests steht (docker.io ohne Registry, library/ ohne Präfix)
 */
export function imageZerlegen(angabe) {
  let s = String(angabe || '').trim();
  if (!s || /\s/.test(s)) return null;
  let digest = null;
  const at = s.indexOf('@');
  if (at >= 0) { digest = s.slice(at + 1); s = s.slice(0, at); }
  let tag = null;
  const doppel = s.lastIndexOf(':');
  if (doppel > s.lastIndexOf('/')) { tag = s.slice(doppel + 1); s = s.slice(0, doppel); }
  const teile = s.split('/');
  let registry = 'docker.io';
  if (teile.length > 1 && (teile[0].includes('.') || teile[0].includes(':') || teile[0] === 'localhost')) registry = teile.shift();
  let repo = teile.join('/');
  if (!repo) return null;
  if (registry === 'docker.io' && !repo.includes('/')) repo = `library/${repo}`;
  if (!tag && !digest) tag = 'latest';
  const name = registry === 'docker.io' ? repo.replace(/^library\//, '') : `${registry}/${repo}`;
  return { registry, repo, tag, digest, name };
}

/** Bearer-Hinweis aus WWW-Authenticate: {realm, service, scope} oder null. */
export function bearerHinweis(kopf) {
  const m = /^\s*Bearer\s+(.*)$/i.exec(String(kopf || ''));
  if (!m) return null;
  const aus = {};
  for (const t of m[1].matchAll(/(\w+)="([^"]*)"/g)) aus[t[1].toLowerCase()] = t[2];
  return aus.realm ? aus : null;
}

/** Digests aus `docker image inspect --format '{{json .RepoDigests}}'` für einen Repo-Namen (sha256:…). */
export function lokaleDigests(repoDigests, name) {
  const aus = [];
  for (const e of Array.isArray(repoDigests) ? repoDigests : []) {
    const [n, d] = String(e).split('@');
    if (!d) continue;
    if (n === name || n === `docker.io/${name}` || n === `docker.io/library/${name}` || n.replace(/^docker\.io\/(library\/)?/, '') === name) aus.push(d);
  }
  return aus;
}

/**
 * Digest des Tags in der Registry. `abruf` = fetch (Tests setzen eine Attrappe).
 * @returns {Promise<string>} sha256:… – wirft bei Netz-/Anmeldefehlern
 */
export async function entfernterDigest(ref, { abruf = globalThis.fetch, zeitlimit_ms = ZEITLIMIT_MS } = {}) {
  const host = ref.registry === 'docker.io' ? DOCKER_HUB : ref.registry;
  const url = `https://${host}/v2/${ref.repo}/manifests/${encodeURIComponent(ref.tag)}`;
  const mitZeit = () => (typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(zeitlimit_ms) : undefined);
  const kopf = async (token) => abruf(url, { method: 'HEAD', redirect: 'follow', signal: mitZeit(), headers: { Accept: ACCEPT, ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
  let r = await kopf(null);
  if (r.status === 401) {
    const h = bearerHinweis(r.headers.get('www-authenticate'));
    if (!h) throw new Error(`${host}: Anmeldung verlangt`);
    const q = new URLSearchParams();
    if (h.service) q.set('service', h.service);
    q.set('scope', h.scope || `repository:${ref.repo}:pull`);
    const tr = await abruf(`${h.realm}?${q}`, { signal: mitZeit(), headers: { Accept: 'application/json' } });
    if (!tr.ok) throw new Error(`${host}: Anmeldung abgelehnt (${tr.status})`);
    const tj = await tr.json();
    const token = tj && (tj.token || tj.access_token);
    if (!token) throw new Error(`${host}: kein Zugangsschlüssel`);
    r = await kopf(token);
  }
  if (r.status === 404) throw new Error(`${ref.name}:${ref.tag} gibt es in der Registry nicht (mehr)`);
  if (!r.ok) throw new Error(`${host}: Antwort ${r.status}`);
  const d = r.headers.get('docker-content-digest');
  if (!d || !/^sha256:[0-9a-f]{64}$/.test(d)) throw new Error(`${host}: kein Digest in der Antwort`);
  return d;
}

/**
 * Ein Image prüfen. `inspect(image)` liefert die RepoDigests des lokalen Images (Array) oder null (nicht vorhanden).
 * @returns {Promise<{image:string, stand:'aktuell'|'update'|'lokal'|'fest'|'fehlt'|'fehler', grund?:string}>}
 */
export async function imagePruefen(image, { inspect, abruf } = {}) {
  const ref = imageZerlegen(image);
  if (!ref) return { image, stand: 'fehler', grund: 'Image-Angabe unlesbar' };
  if (ref.digest) return { image, stand: 'fest' };
  const repoDigests = await inspect(image);
  if (repoDigests === null) return { image, stand: 'fehlt' };
  const lokal = lokaleDigests(repoDigests, ref.name);
  if (!lokal.length) return { image, stand: 'lokal' };
  try {
    const entfernt = await entfernterDigest(ref, { abruf });
    return { image, stand: lokal.includes(entfernt) ? 'aktuell' : 'update' };
  } catch (e) { return { image, stand: 'fehler', grund: String(e && e.message || e).slice(0, 200) }; }
}
