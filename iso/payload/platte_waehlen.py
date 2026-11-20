#!/usr/bin/env python3
# ============================================================================
# Erdacht und programmiert von Fabian Hammer, Deutschland.
# (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
# ============================================================================
"""FAH-NAS Installer – Zielplatte wählen und die storage-Sektion in /autoinstall.yaml schreiben.

Läuft als early-command in der Installer-Umgebung (subiquity, Ubuntu 26.04). Belegter Mechanismus: subiquity kopiert
die Autoinstall-Konfiguration nach /autoinstall.yaml (server.py select_autoinstall → copy_file_if_exists(loc, rootpath))
und liest die Datei nach den early-commands erneut ein (server.py start(): load_autoinstall_config(only_early=True)
→ Early.run() → load_autoinstall_config(only_early=False)); beim Einlesen wird ein umschließender Schlüssel
„autoinstall“ ausgepackt (_read_config: config.pop("autoinstall")). Doku: „The autoinstall configuration is available at
/autoinstall.yaml (irrespective of how it was provided), and the file is re-read after the early-commands have run to
allow them to alter the configuration if necessary.“

Entscheidung:
  1. Kernelparameter fahnas.platte=/dev/sdX gewinnt immer (auch USB/Wechselmedium).
  2. Sonst Kandidaten: interne Platten (type disk, nicht wechselbar, kein USB, kein Installationsmedium, ≥ 32 GiB).
     Genau eine Platte mit btrfs-Label FAHNAS-DATEN → diese (Daten übernehmen, außer fahnas.neu=1).
     Platten mit RAID-/LVM-Mitgliedern (Daten eines Verbunds oder eines anderen NAS, z. B. UGOS) sind nie Kandidat –
     so bleibt beim Umstieg von UGOS genau die alte Systemplatte übrig (19.10.2026).
     Genau ein Kandidat → dieser. Sonst Abbruch mit Liste und Anleitung – NIE raten.
  3. Übernahme: alle Partitionen bleiben (preserve), EFI/Auslagerung/System werden neu formatiert, FAHNAS-DATEN nicht
     (curtin format preserve: true = „curtin will not format the partition“).
  4. Neu: GPT; UEFI: p1 EFI 1 GiB, p2 Auslagerung 8 GiB, p3 System 48 GiB, p4 Daten Rest.
     BIOS: davor p1 bios_grub 1 MiB (GRUB auf GPT braucht das), Nummern +1.
  5. Ist der Ubuntu-Spiegel nicht erreichbar, wird die packages-Liste entfernt (sonst bricht subiquity dort ab –
     install_package wirft nach drei Versuchen), der Erststart holt die Pakete nach.

Test ohne Installer:  platte_waehlen.py --probe lsblk.json [--bios] [--cmdline "…"] [--medium /dev/sr0] → JSON auf stdout
"""
import json
import os
import subprocess
import sys
import time
import urllib.request

GIB = 1024 ** 3
MIB = 1024 ** 2
GROESSE_EFI = 1 * GIB
GROESSE_SWAP = 8 * GIB       # ab 64 GiB Platte
GROESSE_SYSTEM = 48 * GIB    # ab 128 GiB Platte (Entwurf §3); kleinere Platten (VM, Test) bekommen kleinere System-/Swap-Anteile
GROESSE_BIOS_GRUB = 1 * MIB
MIN_PLATTE = 32 * GIB


def groessen_fuer(platte_bytes):
    """(Swap, System) nach Plattengröße: ≥128 GiB → 8/48, ≥64 GiB → 8/32, sonst 4/20 GiB (Mindestplatte 32 GiB)."""
    if platte_bytes >= 128 * GIB:
        return GROESSE_SWAP, GROESSE_SYSTEM
    if platte_bytes >= 64 * GIB:
        return GROESSE_SWAP, 32 * GIB
    return 4 * GIB, 20 * GIB
MIN_DATEN = 4 * GIB
GPT_RESERVE = 34 * 512  # Sicherung der GPT am Plattenende (33 Sektoren) + 1

LABEL_EFI = 'FAHNAS-EFI'
LABEL_SWAP = 'FAHNAS-SWAP'
LABEL_SYSTEM = 'FAHNAS-SYSTEM'
LABEL_DATEN = 'FAHNAS-DATEN'
GUID_ESP = 'c12a7328-f81f-11d2-ba4b-00a0c93ec93b'
GUID_BIOS_GRUB = '21686148-6449-6e6f-744e-656564454649'
GUID_SWAP = '0657fd6d-a4ab-43c4-84e5-0933c84b4f4f'

AUTOINSTALL = '/autoinstall.yaml'
NAMEN_AUSGESCHLOSSEN = ('zram', 'loop', 'ram', 'nbd', 'sr', 'fd', 'md', 'dm-')
LSBLK_SPALTEN = 'NAME,PATH,TYPE,SIZE,RM,RO,MODEL,SERIAL,TRAN,PKNAME,LABEL,FSTYPE,PARTTYPE,PARTN,START,MOUNTPOINT'


class Abbruch(Exception):
    """Fehler mit Meldung für den Nutzer – führt zu Exit ≠ 0 (subiquity zeigt den fehlgeschlagenen Befehl an)."""


PROBE_MODUS = False


def melden(text):
    # im Probe-Modus geht das JSON-Ergebnis nach stdout, alles andere nach stderr
    print(text, file=sys.stderr if PROBE_MODUS else sys.stdout, flush=True)


def zahl(w, standard=0):
    if w is None or w == '':
        return standard
    try:
        return int(w)
    except (TypeError, ValueError):
        try:
            return int(float(w))
        except (TypeError, ValueError):
            return standard


def wahr(w):
    return w in (True, 1, '1', 'true', 'True', 'yes')


def align_down(wert, schritt):
    return (wert // schritt) * schritt


def gb(bytes_):
    return '%.0f GB' % (bytes_ / 1e9)


# ---------------------------------------------------------------------------------------------------------------
# Systemabfragen (im Test durch --probe ersetzt)
# ---------------------------------------------------------------------------------------------------------------
def lsblk_lesen():
    r = subprocess.run(['lsblk', '-J', '-b', '-o', LSBLK_SPALTEN], capture_output=True, text=True, check=False)
    if r.returncode != 0:
        raise Abbruch('lsblk schlug fehl: %s' % r.stderr.strip())
    return json.loads(r.stdout)


def medium_ermitteln():
    """Platte, von der installiert wird (/cdrom), damit sie nie Ziel wird."""
    r = subprocess.run(['findmnt', '-n', '-o', 'SOURCE', '/cdrom'], capture_output=True, text=True, check=False)
    quelle = r.stdout.strip().split('\n')[0].strip() if r.returncode == 0 else ''
    return quelle.split('[')[0] if quelle else ''


def cmdline_lesen():
    try:
        with open('/proc/cmdline', encoding='utf-8') as f:
            return f.read()
    except OSError:
        return ''


def uefi_erkannt():
    return os.path.isdir('/sys/firmware/efi')


def codename():
    try:
        with open('/etc/os-release', encoding='utf-8') as f:
            for zeile in f:
                if zeile.startswith('VERSION_CODENAME='):
                    return zeile.split('=', 1)[1].strip().strip('"')
    except OSError:
        pass
    return 'resolute'


def spiegel_erreichbar(versuche=6, wartezeit_s=3):
    url = 'http://archive.ubuntu.com/ubuntu/dists/%s/InRelease' % codename()
    for i in range(versuche):
        try:
            anfrage = urllib.request.Request(url, method='HEAD')
            with urllib.request.urlopen(anfrage, timeout=5) as antwort:
                if 200 <= antwort.status < 400:
                    return True
        except Exception:  # pylint: disable=broad-except
            pass
        if i + 1 < versuche:
            time.sleep(wartezeit_s)
    return False


# ---------------------------------------------------------------------------------------------------------------
# Plattenwahl
# ---------------------------------------------------------------------------------------------------------------
def cmdline_wert(cmdline, schluessel):
    for teil in cmdline.split():
        if teil.startswith(schluessel + '='):
            return teil.split('=', 1)[1]
    return None


def platten(lsblk):
    aus = []
    for g in lsblk.get('blockdevices', []):
        if g.get('type') != 'disk':
            continue
        kinder = g.get('children') or []
        teile = []
        for k in kinder:
            if k.get('type') != 'part':
                continue
            teile.append({
                'path': k.get('path') or ('/dev/' + k.get('name', '')), 'name': k.get('name', ''), 'size': zahl(k.get('size')),
                'start': zahl(k.get('start')), 'partn': zahl(k.get('partn')), 'label': k.get('label') or '',
                'fstype': (k.get('fstype') or '').lower(), 'parttype': (k.get('parttype') or '').lower(), 'mountpoint': k.get('mountpoint') or '',
            })
        teile.sort(key=lambda t: t['partn'] or 0)
        aus.append({
            'path': g.get('path') or ('/dev/' + g.get('name', '')), 'name': g.get('name', ''), 'size': zahl(g.get('size')),
            'rm': wahr(g.get('rm')), 'ro': wahr(g.get('ro')), 'model': (g.get('model') or '').strip(), 'serial': (g.get('serial') or '').strip(),
            'tran': (g.get('tran') or '').lower(), 'teile': teile, 'fstype': (g.get('fstype') or '').lower(),
        })
    return aus


def medium_platte(alle, medium):
    """Gerätepfad der Platte hinter dem Installationsmedium (Partition → Platte)."""
    if not medium:
        return ''
    for p in alle:
        if p['path'] == medium:
            return p['path']
        for t in p['teile']:
            if t['path'] == medium:
                return p['path']
    return medium


# Signaturen von Speicherverbünden: Mitglied eines Software-RAIDs, eines LVM oder eines ZFS-Pools
VERBUND_SIGNATUREN = ('linux_raid_member', 'lvm2_member', 'zfs_member')


def ist_verbund_mitglied(p):
    return p.get('fstype') in VERBUND_SIGNATUREN or any(t['fstype'] in VERBUND_SIGNATUREN for t in p['teile'])


def hat_daten(p):
    return any(t['label'] == LABEL_DATEN and t['fstype'] == 'btrfs' for t in p['teile'])


def beschreibung(p):
    extras = []
    if p['model']:
        extras.append(p['model'])
    if p['tran']:
        extras.append(p['tran'])
    if p['rm']:
        extras.append('wechselbar')
    if hat_daten(p):
        extras.append('enthält FAHNAS-DATEN')
    if ist_verbund_mitglied(p):
        extras.append('RAID/LVM')
    return '%s (%s%s)' % (p['path'], gb(p['size']), ', ' + ', '.join(extras) if extras else '')


def kandidaten(alle, medium):
    aus, gruende = [], []
    for p in alle:
        if p['path'] == medium:
            gruende.append('%s: Installationsmedium' % p['path'])
            continue
        if p['name'].startswith(NAMEN_AUSGESCHLOSSEN):
            continue
        if p['ro']:
            gruende.append('%s: nur lesbar' % p['path'])
            continue
        if p['rm'] or p['tran'] == 'usb':
            gruende.append('%s: Wechselmedium/USB (nur mit fahnas.platte= erlaubt)' % p['path'])
            continue
        if p['size'] < MIN_PLATTE:
            gruende.append('%s: zu klein (%s, mindestens 32 GiB)' % (p['path'], gb(p['size'])))
            continue
        if ist_verbund_mitglied(p):
            gruende.append('%s: Teil eines RAID/LVM-Speichers (Daten – wird nie automatisch gewählt, nur mit fahnas.platte=)' % beschreibung(p))
            continue
        aus.append(p)
    return aus, gruende


def platte_waehlen(alle, medium, cmdline):
    """Gibt (platte, hinweise) zurück oder wirft Abbruch."""
    hinweise = []
    gewuenscht = cmdline_wert(cmdline, 'fahnas.platte')
    if gewuenscht:
        for p in alle:
            if p['path'] == gewuenscht or p['name'] == os.path.basename(gewuenscht):
                if p['path'] == medium:
                    raise Abbruch('fahnas.platte=%s ist das Installationsmedium selbst.' % gewuenscht)
                if p['size'] < MIN_PLATTE:
                    raise Abbruch('fahnas.platte=%s ist zu klein (%s, mindestens 32 GiB).' % (gewuenscht, gb(p['size'])))
                hinweise.append('Zielplatte per Kernelparameter: %s' % beschreibung(p))
                return p, hinweise
        raise Abbruch('fahnas.platte=%s: keine solche Platte. Vorhanden: %s' % (gewuenscht, ', '.join(beschreibung(p) for p in alle) or 'keine'))

    kand, gruende = kandidaten(alle, medium)
    for g in gruende:
        melden('Übersprungen: ' + g)   # sofort ausgeben, damit es auch im Fehlerfall im Protokoll steht
    mit_daten = [p for p in kand if hat_daten(p)]
    if len(mit_daten) == 1:
        hinweise.append('Platte mit FAH-NAS-Datenpartition gefunden: %s' % beschreibung(mit_daten[0]))
        return mit_daten[0], hinweise
    if len(mit_daten) > 1:
        raise Abbruch('Mehrere Platten mit FAHNAS-DATEN: %s. Bitte mit fahnas.platte=/dev/… festlegen.' % ', '.join(beschreibung(p) for p in mit_daten))
    if len(kand) == 1:
        hinweise.append('Einzige passende Platte: %s' % beschreibung(kand[0]))
        return kand[0], hinweise
    if not kand:
        raise Abbruch('Keine passende Zielplatte gefunden (intern, nicht wechselbar, mindestens 32 GiB). Gesehen: %s. '
                      'Eine andere Platte erzwingen: im GRUB-Menü mit „e“ die Zeile „linux …“ um fahnas.platte=/dev/sdX ergänzen.'
                      % (', '.join(beschreibung(p) for p in alle) or 'keine Platten'))
    raise Abbruch('Mehrere mögliche Zielplatten: %s. FAH-NAS rät nicht – entweder die anderen Platten abziehen oder im '
                  'GRUB-Menü mit „e“ die Zeile „linux …“ um fahnas.platte=/dev/sdX ergänzen und mit F10 starten.'
                  % '; '.join(beschreibung(p) for p in kand))


# ---------------------------------------------------------------------------------------------------------------
# storage-Konfiguration (curtin v2)
# ---------------------------------------------------------------------------------------------------------------
def disk_aktion(p, preserve, grub_device):
    a = {'type': 'disk', 'id': 'fahnas-platte', 'path': p['path'], 'ptable': 'gpt', 'preserve': preserve, 'grub_device': grub_device}
    if not preserve:
        a['wipe'] = 'superblock-recursive'
    # Bewusst nur „path“: der Gerätename ist innerhalb desselben Startvorgangs stabil; curtins Seriennummern-Suche
    # (Teilstring in /dev/disk/by-id) wäre bei virtuellen Platten ohne Seriennummer oder Doppeltreffern eine Fehlerquelle.
    return a


def part_aktion(id_, nummer, groesse, flag=None, grub_device=False, preserve=False, offset=None):
    a = {'type': 'partition', 'id': id_, 'device': 'fahnas-platte', 'number': nummer, 'size': int(groesse), 'preserve': preserve, 'grub_device': grub_device}
    if flag:
        a['flag'] = flag
    if not preserve:
        a['wipe'] = 'superblock'
    if offset is not None:
        a['offset'] = int(offset)
    return a


def format_aktion(id_, volume, fstype, label=None, preserve=False):
    a = {'type': 'format', 'id': id_, 'volume': volume, 'fstype': fstype, 'preserve': preserve}
    if label:
        a['label'] = label
    return a


def mount_aktion(id_, device, pfad):
    return {'type': 'mount', 'id': id_, 'device': device, 'path': pfad}


def layout_neu(p, uefi):
    """Leere Platte: feste Aufteilung, Datenpartition = Rest."""
    aktionen = [disk_aktion(p, preserve=False, grub_device=not uefi)]
    nummer = 1
    start = MIB
    if not uefi:
        aktionen.append(part_aktion('fahnas-p%d' % nummer, nummer, GROESSE_BIOS_GRUB, flag='bios_grub'))
        start += GROESSE_BIOS_GRUB
        nummer += 1
    aktionen.append(part_aktion('fahnas-p%d' % nummer, nummer, GROESSE_EFI, flag='boot', grub_device=uefi))
    aktionen.append(format_aktion('fahnas-f%d' % nummer, 'fahnas-p%d' % nummer, 'fat32', LABEL_EFI))
    aktionen.append(mount_aktion('fahnas-m%d' % nummer, 'fahnas-f%d' % nummer, '/boot/efi'))
    start += GROESSE_EFI
    nummer += 1
    swap, system = groessen_fuer(p['size'])
    aktionen.append(part_aktion('fahnas-p%d' % nummer, nummer, swap, flag='swap'))
    aktionen.append(format_aktion('fahnas-f%d' % nummer, 'fahnas-p%d' % nummer, 'swap', LABEL_SWAP))
    start += swap
    nummer += 1
    aktionen.append(part_aktion('fahnas-p%d' % nummer, nummer, system))
    aktionen.append(format_aktion('fahnas-f%d' % nummer, 'fahnas-p%d' % nummer, 'btrfs', LABEL_SYSTEM))
    aktionen.append(mount_aktion('fahnas-m%d' % nummer, 'fahnas-f%d' % nummer, '/'))
    start += system
    nummer += 1
    ende = align_down(p['size'] - GPT_RESERVE, MIB)
    daten = ende - start   # nur für die Mindestgrößen-Prüfung und den Hinweistext (ungefährer Rest)
    if daten < MIN_DATEN:
        raise Abbruch('Platte %s ist zu klein: nach EFI, Auslagerung und System blieben nur %s für die Daten (mindestens 4 GiB).' % (p['path'], gb(max(daten, 0))))
    # size -1 = „Rest der Platte“ (Autoinstall-Referenz, storage: „For the last partition specified for a particular device,
    # you can specify the size as -1 to indicate that the partition should fill the remaining space.“). subiquity rechnet
    # dann mit den echten Ausrichtungsdaten der Platte (auch 4Kn: GPT-Sicherung 33 × 4096 Byte) – unsere eigene Rechnung
    # mit 34 × 512 Byte Reserve könnte am Plattenende in die Sicherung ragen und curtin/sfdisk ablehnen lassen.
    aktionen.append(part_aktion('fahnas-p%d' % nummer, nummer, -1))
    aktionen.append(format_aktion('fahnas-f%d' % nummer, 'fahnas-p%d' % nummer, 'btrfs', LABEL_DATEN))
    return aktionen, daten


def layout_uebernahme(p, uefi):
    """Vorhandene FAH-NAS-Platte: Partitionstabelle bleibt, System/EFI/Auslagerung neu formatiert, Daten unangetastet."""
    rollen = {}
    unbekannt = []
    for t in p['teile']:
        if t['label'] == LABEL_DATEN and t['fstype'] == 'btrfs':
            rolle = 'daten'
        elif t['label'] == LABEL_SYSTEM:
            rolle = 'system'
        elif t['label'] == LABEL_SWAP or t['fstype'] == 'swap' or t['parttype'] == GUID_SWAP:
            rolle = 'swap'
        elif t['label'] == LABEL_EFI or t['parttype'] == GUID_ESP:
            rolle = 'efi'
        elif t['parttype'] == GUID_BIOS_GRUB:
            rolle = 'bios_grub'
        else:
            unbekannt.append(t)
            continue
        if rolle in rollen:
            raise Abbruch('Auf %s gibt es die Rolle „%s“ doppelt (%s und %s) – Aufbau unklar, bitte fahnas.neu=1 (löscht die Daten!) oder von Hand aufräumen.'
                          % (p['path'], rolle, rollen[rolle]['path'], t['path']))
        rollen[rolle] = t
    fehlt = [r for r in ('efi', 'swap', 'system', 'daten') if r not in rollen]
    if fehlt:
        raise Abbruch('Auf %s liegt FAHNAS-DATEN, aber der übrige FAH-NAS-Aufbau fehlt (%s). Übernahme unmöglich. Entweder die Daten sichern und '
                      'mit fahnas.neu=1 komplett neu einrichten, oder die Partitionen von Hand mit den Labels FAHNAS-EFI/FAHNAS-SWAP/FAHNAS-SYSTEM anlegen.'
                      % (p['path'], ', '.join(fehlt)))
    if not uefi and 'bios_grub' not in rollen:
        raise Abbruch('Rechner startet im BIOS-Modus, aber die vorhandene FAH-NAS-Platte %s hat keine bios_grub-Partition (wurde per UEFI eingerichtet). '
                      'Im UEFI-Modus starten oder mit fahnas.neu=1 (löscht die Daten!) neu einrichten.' % p['path'])
    if rollen['system']['size'] < 16 * GIB:
        raise Abbruch('Die vorhandene Systempartition %s ist mit %s zu klein.' % (rollen['system']['path'], gb(rollen['system']['size'])))

    aktionen = [disk_aktion(p, preserve=True, grub_device=not uefi)]
    for t in p['teile']:
        n = t['partn']
        if not n or not t['start']:
            raise Abbruch('Partition %s ohne Nummer/Startsektor in lsblk – Übernahme unmöglich.' % t['path'])
        offset = t['start'] * 512  # lsblk START zählt immer 512-Byte-Sektoren
        rolle = next((r for r, x in rollen.items() if x is t), None)
        pid = 'fahnas-p%d' % n
        if rolle == 'efi':
            aktionen.append(part_aktion(pid, n, t['size'], flag='boot', grub_device=uefi, preserve=True, offset=offset))
            aktionen.append(format_aktion('fahnas-f%d' % n, pid, 'fat32', LABEL_EFI))
            aktionen.append(mount_aktion('fahnas-m%d' % n, 'fahnas-f%d' % n, '/boot/efi'))
        elif rolle == 'swap':
            aktionen.append(part_aktion(pid, n, t['size'], flag='swap', preserve=True, offset=offset))
            aktionen.append(format_aktion('fahnas-f%d' % n, pid, 'swap', LABEL_SWAP))
        elif rolle == 'system':
            aktionen.append(part_aktion(pid, n, t['size'], preserve=True, offset=offset))
            aktionen.append(format_aktion('fahnas-f%d' % n, pid, 'btrfs', LABEL_SYSTEM))
            aktionen.append(mount_aktion('fahnas-m%d' % n, 'fahnas-f%d' % n, '/'))
        elif rolle == 'daten':
            aktionen.append(part_aktion(pid, n, t['size'], preserve=True, offset=offset))
            aktionen.append(format_aktion('fahnas-f%d' % n, pid, 'btrfs', LABEL_DATEN, preserve=True))
        elif rolle == 'bios_grub':
            aktionen.append(part_aktion(pid, n, t['size'], flag='bios_grub', preserve=True, offset=offset))
        else:
            # fremde Partition: bleibt unangetastet (kein format, kein mount)
            aktionen.append(part_aktion(pid, n, t['size'], preserve=True, offset=offset))
    return aktionen, rollen['daten']['size'], [t['path'] for t in unbekannt]


def storage_bauen(p, uefi, neu_erzwingen):
    hinweise = []
    if hat_daten(p) and not neu_erzwingen:
        aktionen, daten, fremd = layout_uebernahme(p, uefi)
        modus = 'uebernahme'
        hinweise.append('Übernahme: Datenpartition FAHNAS-DATEN (%s) bleibt erhalten, System/EFI/Auslagerung werden neu formatiert.' % gb(daten))
        for f in fremd:
            hinweise.append('Fremde Partition bleibt unangetastet: %s' % f)
    else:
        if hat_daten(p):
            hinweise.append('ACHTUNG: fahnas.neu=1 – vorhandene FAHNAS-DATEN auf %s wird GELÖSCHT.' % p['path'])
        aktionen, daten = layout_neu(p, uefi)
        modus = 'neu'
        hinweise.append('Neue Aufteilung auf %s: EFI 1 GiB, Auslagerung 8 GiB, System 48 GiB, Daten %s%s.'
                        % (p['path'], gb(daten), '' if uefi else ' (+ 1 MiB bios_grub für BIOS-Start)'))
    return {'version': 2, 'swap': {'size': 0}, 'config': aktionen}, modus, hinweise


# ---------------------------------------------------------------------------------------------------------------
# /autoinstall.yaml umschreiben
# ---------------------------------------------------------------------------------------------------------------
def autoinstall_umschreiben(pfad, storage, pakete_entfernen):
    import yaml  # pylint: disable=import-outside-toplevel  (python3-yaml ist Abhängigkeit von subiquity)
    with open(pfad, encoding='utf-8') as f:
        cfg = yaml.safe_load(f) or {}
    wurzel = cfg['autoinstall'] if isinstance(cfg.get('autoinstall'), dict) else cfg
    wurzel['storage'] = storage
    entfernt = None
    if pakete_entfernen and 'packages' in wurzel:
        entfernt = wurzel.pop('packages')
    text = '#cloud-config\n# Von FAH-NAS platte_waehlen.py umgeschrieben (storage-Sektion) – subiquity liest diese Datei nach den early-commands neu.\n'
    text += yaml.safe_dump(cfg, default_flow_style=False, sort_keys=False, allow_unicode=True)
    tmp = pfad + '.fahnas.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        f.write(text)
    os.replace(tmp, pfad)
    return entfernt


def hauptprogramm(argv):
    probe = None
    bios = False
    cmdline = None
    medium = None
    ohne_netz = False
    args = list(argv)
    while args:
        a = args.pop(0)
        if a == '--probe':
            probe = args.pop(0)
        elif a == '--bios':
            bios = True
        elif a == '--cmdline':
            cmdline = args.pop(0)
        elif a == '--medium':
            medium = args.pop(0)
        elif a == '--ohne-netz':
            ohne_netz = True
        else:
            raise Abbruch('Unbekannte Option %s' % a)

    if probe:
        global PROBE_MODUS  # pylint: disable=global-statement
        PROBE_MODUS = True
        with open(probe, encoding='utf-8') as f:
            lsblk = json.load(f)
        uefi = not bios
        cmdline = cmdline or ''
        medium = medium or ''
    else:
        lsblk = lsblk_lesen()
        uefi = uefi_erkannt()
        cmdline = cmdline_lesen()
        medium = medium_ermitteln()

    alle = platten(lsblk)
    medium_disk = medium_platte(alle, medium)
    melden('Startmodus: %s · Installationsmedium: %s' % ('UEFI' if uefi else 'BIOS', medium_disk or 'unbekannt'))
    for p in alle:
        melden('  Platte %s' % beschreibung(p))
    platte, hinweise = platte_waehlen(alle, medium_disk, cmdline)
    neu_erzwingen = cmdline_wert(cmdline, 'fahnas.neu') in ('1', 'ja', 'true')
    storage, modus, h2 = storage_bauen(platte, uefi, neu_erzwingen)
    hinweise += h2

    if probe:
        print(json.dumps({'platte': platte['path'], 'modus': modus, 'uefi': uefi, 'storage': storage, 'hinweise': hinweise}, indent=1, ensure_ascii=False))
        return 0

    for h in hinweise:
        melden(h)
    pakete_entfernen = False
    if not ohne_netz:
        if spiegel_erreichbar():
            melden('Ubuntu-Spiegel erreichbar – Pakete werden während der Installation eingespielt.')
        else:
            pakete_entfernen = True
            melden('Ubuntu-Spiegel NICHT erreichbar – packages-Liste wird entfernt, der Erststart installiert die Pakete nach, sobald Internet da ist.')
    entfernt = autoinstall_umschreiben(AUTOINSTALL, storage, pakete_entfernen)
    if entfernt:
        melden('Entfernt aus %s: packages (%d Einträge).' % (AUTOINSTALL, len(entfernt)))
    melden('%s geschrieben: Zielplatte %s, Modus %s.' % (AUTOINSTALL, platte['path'], modus))
    return 0


if __name__ == '__main__':
    try:
        sys.exit(hauptprogramm(sys.argv[1:]))
    except Abbruch as e:
        melden('FEHLER: %s' % e)
        sys.exit(2)
