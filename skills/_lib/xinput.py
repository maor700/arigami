#!/usr/bin/env python3
# Minimal X11 input driver for THIS session's desktop (S3 / connect-* playbooks).
#
# The session desktop is a bare Xvfb + x11vnc pair — no xdotool, no accessibility
# stack. libX11 + libXtst are always present (Chrome needs them), so we drive
# the pointer/keyboard through the XTEST extension via ctypes. stdlib only.
#
# Usage (DISPLAY must be this session's display — the host sets it):
#   xinput.py move X Y
#   xinput.py click X Y [button]      # button 1=left (default) 2=middle 3=right
#   xinput.py dblclick X Y
#   xinput.py key  NAME[+NAME...]     # e.g. Return, Tab, Escape, ctrl+l, ctrl+a, alt+F4
#   xinput.py type TEXT               # printable ASCII only (URLs, one-time device
#                                     # codes). NEVER passwords / 2FA / OTP — those are
#                                     # the human's (request_screen). Non-ASCII → error 3.
#   xinput.py size                    # prints "W H" of the root window
#
# Exit codes: 0 ok · 2 usage · 3 unsupported text · 4 cannot open DISPLAY.
import ctypes
import ctypes.util
import os
import sys
import time

MODS = {
    'ctrl': 'Control_L', 'control': 'Control_L',
    'alt': 'Alt_L', 'shift': 'Shift_L', 'super': 'Super_L', 'meta': 'Super_L',
}
# Names for keys whose keysym name is not the character itself.
NAMED = {
    'enter': 'Return', 'return': 'Return', 'tab': 'Tab', 'esc': 'Escape', 'escape': 'Escape',
    'space': 'space', 'backspace': 'BackSpace', 'delete': 'Delete', 'home': 'Home', 'end': 'End',
    'pageup': 'Prior', 'pagedown': 'Next', 'up': 'Up', 'down': 'Down', 'left': 'Left', 'right': 'Right',
}


def die(msg, code=2):
    sys.stderr.write(f'xinput: {msg}\n')
    sys.exit(code)


def libs():
    x = ctypes.util.find_library('X11') or 'libX11.so.6'
    t = ctypes.util.find_library('Xtst') or 'libXtst.so.6'
    try:
        X = ctypes.cdll.LoadLibrary(x)
        T = ctypes.cdll.LoadLibrary(t)
    except OSError as e:
        die(f'cannot load X11/XTest libraries: {e}', 4)
    X.XOpenDisplay.restype = ctypes.c_void_p
    X.XOpenDisplay.argtypes = [ctypes.c_char_p]
    X.XCloseDisplay.argtypes = [ctypes.c_void_p]
    X.XFlush.argtypes = [ctypes.c_void_p]
    X.XSync.argtypes = [ctypes.c_void_p, ctypes.c_int]
    X.XStringToKeysym.restype = ctypes.c_ulong
    X.XStringToKeysym.argtypes = [ctypes.c_char_p]
    X.XKeysymToKeycode.restype = ctypes.c_ubyte
    X.XKeysymToKeycode.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
    X.XKeycodeToKeysym.restype = ctypes.c_ulong
    X.XKeycodeToKeysym.argtypes = [ctypes.c_void_p, ctypes.c_ubyte, ctypes.c_int]
    X.XDefaultScreen.argtypes = [ctypes.c_void_p]
    X.XDisplayWidth.argtypes = [ctypes.c_void_p, ctypes.c_int]
    X.XDisplayHeight.argtypes = [ctypes.c_void_p, ctypes.c_int]
    T.XTestFakeMotionEvent.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_ulong]
    T.XTestFakeButtonEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]
    T.XTestFakeKeyEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]
    return X, T


class Driver:
    def __init__(self):
        if not os.environ.get('DISPLAY'):
            die('DISPLAY is not set — this session has no desktop yet (open Chrome via skills/_lib/chrome.sh first)', 4)
        self.X, self.T = libs()
        self.d = self.X.XOpenDisplay(None)
        if not self.d:
            die(f'cannot open DISPLAY {os.environ.get("DISPLAY")}', 4)

    def close(self):
        self.X.XFlush(self.d)
        self.X.XSync(self.d, 0)
        self.X.XCloseDisplay(self.d)

    def size(self):
        s = self.X.XDefaultScreen(self.d)
        return self.X.XDisplayWidth(self.d, s), self.X.XDisplayHeight(self.d, s)

    def move(self, x, y):
        self.T.XTestFakeMotionEvent(self.d, -1, int(x), int(y), 0)
        self.X.XFlush(self.d)

    def click(self, x, y, button=1, times=1):
        self.move(x, y)
        time.sleep(0.05)
        for _ in range(times):
            self.T.XTestFakeButtonEvent(self.d, button, 1, 0)
            self.T.XTestFakeButtonEvent(self.d, button, 0, 0)
            self.X.XFlush(self.d)
            time.sleep(0.08)

    def _keycode(self, keysym):
        kc = self.X.XKeysymToKeycode(self.d, keysym)
        if not kc:
            return 0, False
        # Does this keycode produce the keysym unshifted, or only with Shift?
        plain = self.X.XKeycodeToKeysym(self.d, kc, 0)
        return kc, plain != keysym

    def _press(self, kc, down):
        self.T.XTestFakeKeyEvent(self.d, kc, 1 if down else 0, 0)
        self.X.XFlush(self.d)

    def key(self, combo):
        parts = [p for p in combo.split('+') if p]
        if not parts:
            die('empty key combo')
        mods, main = [], parts[-1]
        for p in parts[:-1]:
            name = MODS.get(p.lower())
            if not name:
                die(f'unknown modifier {p!r}')
            mods.append(name)
        main_name = NAMED.get(main.lower(), main)
        keysym = self.X.XStringToKeysym(main_name.encode())
        if not keysym and len(main) == 1:
            keysym = ord(main)
        if not keysym:
            die(f'unknown key {main!r}')
        kc, need_shift = self._keycode(keysym)
        if not kc:
            die(f'key {main!r} is not on the keymap')
        held = []
        for m in mods + (['Shift_L'] if need_shift else []):
            mkc = self.X.XKeysymToKeycode(self.d, self.X.XStringToKeysym(m.encode()))
            self._press(mkc, True)
            held.append(mkc)
        self._press(kc, True)
        self._press(kc, False)
        for mkc in reversed(held):
            self._press(mkc, False)
        time.sleep(0.03)

    def type(self, text):
        for ch in text:
            if ch == '\n':
                self.key('Return'); continue
            if ch == '\t':
                self.key('Tab'); continue
            if not (0x20 <= ord(ch) <= 0x7e):
                die(f'unsupported character {ch!r} — only printable ASCII can be typed', 3)
            kc, need_shift = self._keycode(ord(ch))
            if not kc:
                die(f'character {ch!r} is not on the keymap', 3)
            if need_shift:
                skc = self.X.XKeysymToKeycode(self.d, self.X.XStringToKeysym(b'Shift_L'))
                self._press(skc, True)
            self._press(kc, True)
            self._press(kc, False)
            if need_shift:
                self._press(skc, False)
            time.sleep(0.015)


def main(argv):
    if len(argv) < 2:
        die(__doc__ or 'usage: xinput.py <move|click|dblclick|key|type|size> ...')
    cmd, args = argv[1], argv[2:]
    drv = Driver()
    try:
        if cmd == 'size':
            print('%d %d' % drv.size())
        elif cmd == 'move' and len(args) == 2:
            drv.move(*args)
        elif cmd == 'click' and len(args) in (2, 3):
            drv.click(args[0], args[1], int(args[2]) if len(args) == 3 else 1)
        elif cmd == 'dblclick' and len(args) == 2:
            drv.click(args[0], args[1], 1, times=2)
        elif cmd == 'key' and len(args) == 1:
            drv.key(args[0])
        elif cmd == 'type' and len(args) == 1:
            drv.type(args[0])
        else:
            die(f'bad usage: {cmd} {args}')
    finally:
        drv.close()


if __name__ == '__main__':
    main(sys.argv)
