// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Grafikkarten für Apps (Betreiber 12.10.2026: „sichergestellt, dass GPU bspw. durchgereicht wird“ – Voraussetzung für
// allinone auf dem FAH-NAS). Reine Auswertungen ohne Systemzugriff: lspci, nvidia-smi, docker inspect, und das
// Einrichtungsskript für NVIDIA (Treiber über ubuntu-drivers, Container-Toolkit aus NVIDIAs Paketquelle, weil Ubuntu
// 26.04 es nicht mitbringt).

export const HERSTELLER = Object.freeze({ '8086': 'intel', '1002': 'amd', '10de': 'nvidia' });
export const GPU_ARTEN = Object.freeze(['keine', 'dri', 'nvidia']);

/** `lspci -mm -nn -D` → Grafikkarten [{adresse, hersteller, hersteller_name, modell, klasse}] (Klasse 03xx). */
export function lspciParsen(text) {
  const aus = [];
  for (const z of String(text || '').split('\n')) {
    const t = [...z.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
    const adresse = z.split(' ')[0];
    if (t.length < 3 || !/\[03[0-9a-f]{2}\]$/.test(t[0])) continue;
    const hid = (/\[([0-9a-f]{4})\]$/.exec(t[1]) || [])[1] || '';
    aus.push({ adresse, hersteller: HERSTELLER[hid] || 'andere', hersteller_name: t[1].replace(/\s*\[[0-9a-f]{4}\]$/, '').replace(/ Corporation$/, ''), modell: t[2].replace(/\s*\[[0-9a-f]{4}\]$/, ''), klasse: t[0].replace(/\s*\[[0-9a-f]{4}\]$/, '') });
  }
  return aus;
}

/** `nvidia-smi --query-gpu=name,driver_version,memory.total,memory.used,utilization.gpu,temperature.gpu --format=csv,noheader,nounits` */
export function nvidiaSmiParsen(text) {
  return String(text || '').trim().split('\n').filter(Boolean).map((z) => {
    const [name, treiber, gesamt, belegt, last, temp] = z.split(',').map((x) => x.trim());
    const zahl = (x) => (Number.isFinite(Number(x)) ? Number(x) : null);
    return { name, treiber, speicher_mb: zahl(gesamt), speicher_belegt_mb: zahl(belegt), auslastung: zahl(last), temperatur: zahl(temp) };
  });
}

/** `docker inspect` (JSON-Liste) → Apps mit GPU: [{container, app, art:'dri'|'nvidia'}]. */
export function gpuNutzer(inspect) {
  const aus = [];
  for (const c of Array.isArray(inspect) ? inspect : []) {
    const hc = (c && c.HostConfig) || {};
    const name = String(c.Name || '').replace(/^\//, '');
    const app = (c.Config && c.Config.Labels && c.Config.Labels['com.docker.compose.project']) || name;
    const nvidia = (hc.DeviceRequests || []).some((d) => d && (d.Driver === 'nvidia' || (d.Capabilities || []).flat().includes('gpu'))) || hc.Runtime === 'nvidia';
    const dri = (hc.Devices || []).some((d) => String(d && d.PathOnHost).startsWith('/dev/dri'));
    if (nvidia || dri) aus.push({ container: name, app: app.replace(/^fahnas-/, ''), art: nvidia ? 'nvidia' : 'dri', laeuft: !!(c.State && c.State.Running) });
  }
  return aus;
}

/** GPU-Art eines Dienstes aus `docker compose config --format json`. */
export function gpuAusDienst(d) {
  if (!d || typeof d !== 'object') return 'keine';
  const res = d.deploy && d.deploy.resources && d.deploy.resources.reservations;
  if (d.runtime === 'nvidia' || ((res && res.devices) || []).some((x) => x && (x.driver === 'nvidia' || (x.capabilities || []).flat().includes('gpu')))) return 'nvidia';
  if ((Array.isArray(d.devices) ? d.devices : []).some((x) => String(typeof x === 'object' ? x.source : String(x).split(':')[0]).startsWith('/dev/dri'))) return 'dri';
  return 'keine';
}

/** Gruppen-IDs aus /etc/group (render, video) – Container brauchen sie als Zahl (dort gibt es die Namen oft nicht). */
export function gruppenIds(etcGroup) {
  const aus = {};
  for (const z of String(etcGroup || '').split('\n')) { const t = z.split(':'); if (t.length >= 3 && (t[0] === 'render' || t[0] === 'video')) aus[t[0]] = t[2]; }
  return aus;
}

/**
 * Compose-Überschreibungen für die GPU-Wahl (nur aufgerufen, wenn die Wahl vom Original abweicht). Behält fremde Geräte,
 * Gruppen und Deploy-Angaben des Originals. `kfd` = /dev/kfd vorhanden (AMD-Rechenkern, ROCm).
 * @returns {{devices:Array, group_add:Array, deploy?:object}}
 */
export function gpuUeberschreibung(gpu, orig = {}, { gids = {}, kfd = false } = {}) {
  const istDri = (x) => /^\/dev\/(dri|kfd)/.test(String(typeof x === 'object' ? x.source : String(x).split(':')[0]));
  const devices = (Array.isArray(orig.devices) ? orig.devices : []).filter((x) => !istDri(x)).map((x) => (typeof x === 'object' ? x : { source: String(x).split(':')[0], target: String(x).split(':')[1] || String(x).split(':')[0], permissions: 'rwm' }));
  const gidWerte = [gids.render, gids.video].filter(Boolean).map(String);
  let group_add = (Array.isArray(orig.group_add) ? orig.group_add : []).map(String).filter((g) => !gidWerte.includes(g) && g !== 'render' && g !== 'video');
  if (gpu === 'dri') {
    devices.push({ source: '/dev/dri', target: '/dev/dri', permissions: 'rwm' });
    if (kfd) devices.push({ source: '/dev/kfd', target: '/dev/kfd', permissions: 'rwm' });
    group_add = [...group_add, ...gidWerte];
  }
  const aus = { devices, group_add };
  const res = (orig.deploy && orig.deploy.resources) || {};
  const reserv = res.reservations || {};
  const andere = (reserv.devices || []).filter((x) => !(x && (x.driver === 'nvidia' || (x.capabilities || []).flat().includes('gpu'))));
  if (gpu === 'nvidia' || gpuAusDienst(orig) === 'nvidia') {
    const devs = gpu === 'nvidia' ? [...andere, { driver: 'nvidia', count: 'all', capabilities: ['gpu', 'compute', 'utility', 'video'] }] : andere;
    aus.deploy = { ...(orig.deploy || {}), resources: { ...res, reservations: { ...reserv, devices: devs } } };
  }
  return aus;
}

/** Einrichtungsskript NVIDIA (läuft als eigene systemd-Unit; Ausgabe im Journal). */
export const NVIDIA_SKRIPT = [
  'set -e',
  'export DEBIAN_FRONTEND=noninteractive',
  'apt-get -o DPkg::Lock::Timeout=300 -q update',
  'apt-get -o DPkg::Lock::Timeout=300 -q -y install ubuntu-drivers-common curl gpg ca-certificates',
  'if ! command -v nvidia-smi >/dev/null 2>&1; then ubuntu-drivers install; fi',
  'install -d -m 0755 /usr/share/keyrings',
  'curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | gpg --batch --yes --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg',
  'echo "deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://nvidia.github.io/libnvidia-container/stable/deb/$(dpkg --print-architecture) /" > /etc/apt/sources.list.d/nvidia-container-toolkit.list',
  'apt-get -o DPkg::Lock::Timeout=300 -q update',
  'apt-get -o DPkg::Lock::Timeout=300 -q -y install nvidia-container-toolkit',
  'nvidia-ctk runtime configure --runtime=docker',
  'systemctl restart docker',
].join('\n');
