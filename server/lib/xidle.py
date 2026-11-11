#!/usr/bin/env python3
# How long the X display has had no input, printed every INTERVAL ms (one integer of milliseconds per line) until
# killed. shared-desktop.ts reads it to tell the owner's input on the shared screen from the agents' (theirs goes
# through the host, which knows when it happened). XScreenSaver over ctypes — stdlib only, like xinput.py.
#
# Usage (DISPLAY = the shared display):  xidle.py [INTERVAL_MS]      Exit codes: 4 no display / no XScreenSaver.
import ctypes
import os
import sys
import time


class Info(ctypes.Structure):
    _fields_ = [('window', ctypes.c_ulong), ('state', ctypes.c_int), ('kind', ctypes.c_int),
                ('til_or_since', ctypes.c_ulong), ('idle', ctypes.c_ulong), ('eventMask', ctypes.c_ulong)]


def main():
    interval = max(100, int(sys.argv[1])) / 1000 if len(sys.argv) > 1 else 0.5
    try:
        X = ctypes.cdll.LoadLibrary('libX11.so.6')
        S = ctypes.cdll.LoadLibrary('libXss.so.1')
    except OSError as e:
        sys.stderr.write(f'xidle: {e}\n')
        sys.exit(4)
    X.XOpenDisplay.restype = ctypes.c_void_p
    X.XOpenDisplay.argtypes = [ctypes.c_char_p]
    X.XDefaultRootWindow.restype = ctypes.c_ulong
    X.XDefaultRootWindow.argtypes = [ctypes.c_void_p]
    S.XScreenSaverAllocInfo.restype = ctypes.POINTER(Info)
    S.XScreenSaverQueryInfo.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.POINTER(Info)]
    d = X.XOpenDisplay(os.environ.get('DISPLAY', '').encode() or None)
    if not d:
        sys.stderr.write('xidle: cannot open DISPLAY\n')
        sys.exit(4)
    root = X.XDefaultRootWindow(d)
    info = S.XScreenSaverAllocInfo()
    while True:
        if not S.XScreenSaverQueryInfo(d, root, info):
            sys.stderr.write('xidle: no XScreenSaver extension\n')
            sys.exit(4)
        sys.stdout.write(f'{info.contents.idle}\n')
        sys.stdout.flush()
        time.sleep(interval)


if __name__ == '__main__':
    try:
        main()
    except (KeyboardInterrupt, BrokenPipeError):
        pass
