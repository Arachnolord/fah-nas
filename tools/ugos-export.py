#!/usr/bin/env python3
# ============================================================================
# Erdacht und programmiert von Fabian Hammer, Deutschland.
# (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
# ============================================================================
# UGOS-Export für den Umstieg auf FAH-NAS (Betreiber 19.10.2026). Läuft UNTER UGOS, kurz vor dem Umstieg, als normaler
# Admin-Nutzer per SSH (root nicht nötig). Liest NUR – Nutzer, Gruppen und die UGOS-Rechte (system.ugacl_self) der
# Freigabe-Ordner jedes Volumes – und schreibt das Ergebnis als fahnas-ugos-export.json in einen beschreibbaren
# Freigabe-Ordner JEDES Volumes. Der FAH-NAS-Assistent „Speicher übernehmen“ findet die Datei dort und schlägt damit die
# Rechte und die Besitzer-Zuordnung vor. Nach dem Umstieg sind die UGOS-Rechte nicht mehr lesbar (eigenes Kernelmodul).
#
# Aufruf unter UGOS:   python3 ugos-export.py            (schreibt die Datei, zeigt eine Zusammenfassung)
#                      python3 ugos-export.py --nur-zeigen   (schreibt nichts)

import base64, glob, grp, json, os, pwd, socket, subprocess, sys, time

DATEINAME = 'fahnas-ugos-export.json'
# Ablage: lieber in einen gemeinsamen Ordner als in den Ordner einer Person (sonst der erste beschreibbare)
BEVORZUGT = ['docker', 'Docker', 'Backups', 'backups', 'Backup', 'Arbeit', 'Public', 'public', 'Daten', 'daten', 'medien', 'Medien', 'media', 'Media', 'data_backups']


def ugacl(pfad):
    try:
        wert = os.getxattr(pfad, 'system.ugacl_self')
        return base64.b64encode(wert).decode('ascii')
    except OSError:
        return None


MAX_ORDNER = 20000  # je Freigabe so viele Unterordner höchstens ansehen (nur Ordner, keine Dateien)
MAX_TIEFE = 8


def unterordner_rechte(wurzel):
    """Unterordner mit EIGENEN UGOS-Rechten (system.ugacl_self) – UGOS speichert dort die vollständige Liste."""
    aus, gesehen = [], 0
    stapel = [(wurzel, '', 0)]
    while stapel and gesehen < MAX_ORDNER:
        pfad, rel, tiefe = stapel.pop()
        try:
            eintraege = list(os.scandir(pfad))
        except OSError:
            continue
        for e in eintraege:
            if not e.is_dir(follow_symlinks=False) or e.name[:1] in ('#', '@', '.'):
                continue
            gesehen += 1
            r = (rel + '/' + e.name) if rel else e.name
            u = ugacl(e.path)
            if u:
                aus.append({'pfad': r, 'ugacl': u})
            if tiefe + 1 < MAX_TIEFE:
                stapel.append((e.path, r, tiefe + 1))
    return aus


def uuid_von(mount):
    r = subprocess.run(['findmnt', '-n', '-o', 'UUID', mount], capture_output=True, text=True)
    return r.stdout.strip() or None


def main():
    nur_zeigen = '--nur-zeigen' in sys.argv
    nutzer = [{'name': p.pw_name, 'uid': p.pw_uid, 'gid': p.pw_gid} for p in pwd.getpwall() if 1000 <= p.pw_uid < 60000]
    gruppen = [{'name': g.gr_name, 'gid': g.gr_gid, 'mitglieder': list(g.gr_mem)} for g in grp.getgrall() if g.gr_gid in (10, 100) or 1000 <= g.gr_gid < 60000]
    volumes = []
    for mount in sorted(glob.glob('/volume[0-9]*')):
        if not os.path.ismount(mount):
            continue
        ordner = []
        for name in sorted(os.listdir(mount)):
            pfad = os.path.join(mount, name)
            if not os.path.isdir(pfad) or os.path.islink(pfad):
                continue
            if (name.startswith('@') and name != '@home') or name == 'lost+found':
                continue
            st = os.lstat(pfad)
            eintrag = {'name': name, 'uid': st.st_uid, 'ugacl': ugacl(pfad)}
            if name == '@home':
                eintrag['heim'] = [{'name': h, 'uid': os.lstat(os.path.join(pfad, h)).st_uid, 'ugacl': ugacl(os.path.join(pfad, h))}
                                   for h in sorted(os.listdir(pfad)) if os.path.isdir(os.path.join(pfad, h))]
            else:
                eintrag['unter'] = unterordner_rechte(pfad)
            ordner.append(eintrag)
        volumes.append({'mount': mount, 'uuid': uuid_von(mount), 'ordner': ordner})
    export = {'version': 1, 'quelle': 'UGOS', 'rechner': socket.gethostname(), 'erstellt': time.strftime('%Y-%m-%dT%H:%M:%S%z'),
              'nutzer': nutzer, 'gruppen': gruppen, 'volumes': volumes}
    print('UGOS-Export: %d Nutzer, %d Gruppen, %d Volumes' % (len(nutzer), len(gruppen), len(volumes)))
    for v in volumes:
        print('  %s (%s): %s' % (v['mount'], v['uuid'], ', '.join(o['name'] for o in v['ordner']) or '–'))
        for o in v['ordner']:
            if o.get('unter'):
                print('      %s: %d Unterordner mit eigenen Rechten (%s)' % (o['name'], len(o['unter']), ', '.join(x['pfad'] for x in o['unter'][:5])))
    if nur_zeigen:
        return 0
    text = json.dumps(export, ensure_ascii=False, indent=1)
    fehlt = []
    for v in volumes:
        ziel = None
        kandidaten = sorted((o for o in v['ordner'] if o['name'] not in ('@home', 'lost+found')),
                            key=lambda o: BEVORZUGT.index(o['name']) if o['name'] in BEVORZUGT else len(BEVORZUGT))
        for o in kandidaten:
            pfad = os.path.join(v['mount'], o['name'])
            if os.access(pfad, os.W_OK):
                ziel = os.path.join(pfad, DATEINAME)
                break
        if not ziel:
            fehlt.append(v['mount'])
            continue
        with open(ziel, 'w', encoding='utf-8') as f:
            f.write(text)
        print('  geschrieben: %s' % ziel)
    if fehlt:
        print('WARNUNG: kein beschreibbarer Freigabe-Ordner auf %s – dort fehlt der Export.' % ', '.join(fehlt))
    return 0


if __name__ == '__main__':
    sys.exit(main())
