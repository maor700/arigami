#!/usr/bin/env python3
# x11-wallpaper: set an X11 desktop's root background from raw BGRA pixels read
# on stdin (WIDTH*HEIGHT*4 bytes, the order ffmpeg's `-pix_fmt bgra` writes).
# stdlib + libX11 through ctypes only, like skills/_lib/xinput.py: no feh,
# hsetroot or xsetroot in the image. The rendering is server/lib/desktop-wallpaper.ts.
#
# Usage: DISPLAY=:N python3 x11-wallpaper.py WIDTH HEIGHT < pixels.bgra
# Exit codes: 0 ok · 2 usage/bad input · 4 cannot open DISPLAY / no libX11.
import ctypes
import ctypes.util
import sys

C = ctypes


def main():
    if len(sys.argv) != 3:
        sys.stderr.write('x11-wallpaper: usage: x11-wallpaper.py WIDTH HEIGHT < pixels.bgra\n')
        return 2
    w, h = int(sys.argv[1]), int(sys.argv[2])
    data = sys.stdin.buffer.read()
    if w <= 0 or h <= 0 or len(data) != w * h * 4:
        sys.stderr.write(f'x11-wallpaper: expected {w * h * 4} bytes of BGRA, got {len(data)}\n')
        return 2

    lib = ctypes.util.find_library('X11')
    if not lib:
        sys.stderr.write('x11-wallpaper: libX11 not found\n')
        return 4
    x = C.CDLL(lib)
    x.XOpenDisplay.argtypes = [C.c_char_p]
    x.XOpenDisplay.restype = C.c_void_p
    x.XDefaultScreen.argtypes = [C.c_void_p]
    x.XRootWindow.argtypes = [C.c_void_p, C.c_int]
    x.XRootWindow.restype = C.c_ulong
    x.XDefaultVisual.argtypes = [C.c_void_p, C.c_int]
    x.XDefaultVisual.restype = C.c_void_p
    x.XDefaultDepth.argtypes = [C.c_void_p, C.c_int]
    x.XDefaultGC.argtypes = [C.c_void_p, C.c_int]
    x.XDefaultGC.restype = C.c_void_p
    x.XCreatePixmap.argtypes = [C.c_void_p, C.c_ulong, C.c_uint, C.c_uint, C.c_uint]
    x.XCreatePixmap.restype = C.c_ulong
    x.XCreateImage.argtypes = [C.c_void_p, C.c_void_p, C.c_uint, C.c_int, C.c_int,
                               C.c_char_p, C.c_uint, C.c_uint, C.c_int, C.c_int]
    x.XCreateImage.restype = C.c_void_p
    x.XPutImage.argtypes = [C.c_void_p, C.c_ulong, C.c_void_p, C.c_void_p,
                            C.c_int, C.c_int, C.c_int, C.c_int, C.c_uint, C.c_uint]
    x.XSetWindowBackgroundPixmap.argtypes = [C.c_void_p, C.c_ulong, C.c_ulong]
    x.XClearWindow.argtypes = [C.c_void_p, C.c_ulong]
    x.XInternAtom.argtypes = [C.c_void_p, C.c_char_p, C.c_int]
    x.XInternAtom.restype = C.c_ulong
    x.XGetWindowProperty.argtypes = [C.c_void_p, C.c_ulong, C.c_ulong, C.c_long, C.c_long, C.c_int, C.c_ulong,
                                     C.POINTER(C.c_ulong), C.POINTER(C.c_int), C.POINTER(C.c_ulong),
                                     C.POINTER(C.c_ulong), C.POINTER(C.c_void_p)]
    x.XChangeProperty.argtypes = [C.c_void_p, C.c_ulong, C.c_ulong, C.c_ulong, C.c_int, C.c_int, C.c_void_p, C.c_int]
    x.XKillClient.argtypes = [C.c_void_p, C.c_ulong]
    x.XFree.argtypes = [C.c_void_p]
    x.XSetCloseDownMode.argtypes = [C.c_void_p, C.c_int]
    x.XFlush.argtypes = [C.c_void_p]
    x.XCloseDisplay.argtypes = [C.c_void_p]

    dpy = x.XOpenDisplay(None)
    if not dpy:
        sys.stderr.write('x11-wallpaper: cannot open DISPLAY\n')
        return 4
    scr = x.XDefaultScreen(dpy)
    root = x.XRootWindow(dpy, scr)
    depth = x.XDefaultDepth(dpy, scr)
    XA_PIXMAP = 20
    atom = x.XInternAtom(dpy, b'_XROOTPMAP_ID', 0)

    # A pixmap from an earlier run was kept alive with RetainPermanent; free it
    # so repainting (a renamed or recolored session) does not leak server memory.
    rtype, rfmt, nitems, after, prop = C.c_ulong(), C.c_int(), C.c_ulong(), C.c_ulong(), C.c_void_p()
    if x.XGetWindowProperty(dpy, root, atom, 0, 1, 0, XA_PIXMAP, C.byref(rtype), C.byref(rfmt),
                            C.byref(nitems), C.byref(after), C.byref(prop)) == 0 and prop.value:
        if rtype.value == XA_PIXMAP and nitems.value == 1:
            old = C.cast(prop, C.POINTER(C.c_ulong))[0]
            if old:
                x.XKillClient(dpy, old)
        x.XFree(prop)

    buf = C.create_string_buffer(data, len(data))
    ZPixmap = 2
    img = x.XCreateImage(dpy, x.XDefaultVisual(dpy, scr), depth, ZPixmap, 0, C.cast(buf, C.c_char_p), w, h, 32, 0)
    pix = x.XCreatePixmap(dpy, root, w, h, depth)
    x.XPutImage(dpy, pix, x.XDefaultGC(dpy, scr), img, 0, 0, 0, 0, w, h)
    x.XSetWindowBackgroundPixmap(dpy, root, pix)
    x.XClearWindow(dpy, root)
    # Where the wallpaper is, for pseudo-transparent panels (tint2) and terminals.
    pid = C.c_ulong(pix)
    for name in (b'_XROOTPMAP_ID', b'ESETROOT_PMAP_ID'):
        x.XChangeProperty(dpy, root, x.XInternAtom(dpy, name, 0), XA_PIXMAP, 32, 0, C.byref(pid), 1)
    x.XSetCloseDownMode(dpy, 1)  # RetainPermanent: the pixmap outlives this process
    x.XFlush(dpy)
    x.XCloseDisplay(dpy)
    return 0


if __name__ == '__main__':
    sys.exit(main())
