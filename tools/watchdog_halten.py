#!/usr/bin/env python3
# ============================================================================
# Erdacht und programmiert von Fabian Hammer, Deutschland.
# (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
# ============================================================================
# Hardware-Watchdog der UGREEN-DXP-Gehäuse übernehmen (Betreiber 19.10.2026). Unter UGOS läuft der Watchdog des
# Super-I/O IT8613E (am DXP4800 Plus gelesen: aktiv, 178 s) und wird von UGOS' eigenem Dienst bedient. Startet das BIOS
# ihn, setzt er jedes andere System nach drei Minuten zurück – auch den Installer und den ersten Start mit Erststart.
#
# 1. Treiber it87_wdt laden (Ubuntu setzt ihn auf die Sperrliste, lädt ihn also nie von selbst). Erkennt er einen vom BIOS
#    gestarteten Watchdog („Left running by firmware“), hält der Kernel ihn selbst am Leben, bis ein Dienst ihn öffnet.
# 2. Kennt der Treiber den Chip nicht: den Watchdog direkt im Chip ausschalten (LDN 7, Zeitregister 0x73/0x74 = 0).
# Läuft nur auf erkannten UGREEN-DXP-Geräten (DMI), sonst tut es nichts. Exit immer 0 – nichts soll daran hängen.
# Aufruf: python3 watchdog_halten.py [--nur-lesen]

import glob, os, subprocess, sys

IT8613E = 0x8613
SIO_PORTS = (0x2e, 0x4e)
LDN_GPIO = 0x07
WDT_CFG, WDT_LSB, WDT_MSB = 0x72, 0x73, 0x74


def melden(text):
    print('[watchdog] ' + text, flush=True)


def lies_datei(pfad):
    try:
        with open(pfad) as f:
            return f.read().strip()
    except OSError:
        return ''


def ist_dxp():
    produkt = lies_datei('/sys/class/dmi/id/product_name')
    return produkt.upper().startswith('DXP')


def kernel_watchdog():
    """Name/Zustand eines vom Treiber it87_wdt geführten Watchdogs oder None."""
    for d in sorted(glob.glob('/sys/class/watchdog/watchdog*')):
        if lies_datei(d + '/identity') == 'IT87 WDT':
            return {'geraet': os.path.basename(d), 'zustand': lies_datei(d + '/state'), 'sekunden': lies_datei(d + '/timeout')}
    return None


class Port:
    def __init__(self):
        self.fd = os.open('/dev/port', os.O_RDWR)

    def inb(self, port):
        return os.pread(self.fd, 1, port)[0]

    def outb(self, port, wert):
        os.pwrite(self.fd, bytes([wert & 0xff]), port)

    def zu(self):
        os.close(self.fd)


def chip_watchdog(io, ausschalten):
    """Watchdog im IT8613E lesen (und auf Wunsch ausschalten). → (aktiv, sekunden, ausgeschaltet) oder None."""
    for sio in SIO_PORTS:
        io.outb(sio, 0x87); io.outb(sio, 0x01); io.outb(sio, 0x55); io.outb(sio, 0xaa if sio == 0x4e else 0x55)
        try:
            def lies(reg):
                io.outb(sio, reg)
                return io.inb(sio + 1)

            def schreib(reg, wert):
                io.outb(sio, reg)
                io.outb(sio + 1, wert)
            if (lies(0x20) << 8 | lies(0x21)) != IT8613E:
                continue
            schreib(0x07, LDN_GPIO)
            cfg, wert = lies(WDT_CFG), lies(WDT_MSB) << 8 | lies(WDT_LSB)
            sekunden = wert if cfg & 0x80 else wert * 60  # Bit 7: Einheit Sekunden statt Minuten
            aus = False
            if wert and ausschalten:
                schreib(WDT_LSB, 0)
                schreib(WDT_MSB, 0)
                aus = (lies(WDT_MSB) << 8 | lies(WDT_LSB)) == 0
            return wert > 0, sekunden, aus
        finally:
            io.outb(sio, 0x02)
            io.outb(sio + 1, 0x02)
    return None


def main():
    nur_lesen = '--nur-lesen' in sys.argv
    if not ist_dxp():
        return 0
    if not nur_lesen:
        subprocess.run(['modprobe', 'it87_wdt'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    k = kernel_watchdog()
    if k:
        melden('Treiber it87_wdt führt %s (%s, %s s) – der Kernel hält ihn am Leben' % (k['geraet'], k['zustand'] or '?', k['sekunden'] or '?'))
        return 0
    try:
        io = Port()
    except OSError as e:
        melden('kein Zugriff auf /dev/port (%s) – Watchdog nicht übernommen' % e)
        return 0
    try:
        r = chip_watchdog(io, ausschalten=not nur_lesen)
    finally:
        io.zu()
    if r is None:
        melden('kein IT8613E gefunden')
    elif not r[0]:
        melden('Watchdog des IT8613E ist aus')
    elif r[2]:
        melden('Watchdog des IT8613E war an (%d s) – ausgeschaltet (der Treiber kennt den Chip nicht)' % r[1])
    else:
        melden('Watchdog des IT8613E ist an (%d s)%s' % (r[1], '' if nur_lesen else ' – ausschalten fehlgeschlagen'))
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as e:  # nie den Start aufhalten
        melden('Fehler: %s' % e)
        sys.exit(0)
