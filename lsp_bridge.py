"""Minimal WebSocket endpoint that bridges browser LSP clients to ZLS over stdio.

The CodeMirror `codemirror-languageserver` plugin exchanges bare JSON strings
over WebSocket; ZLS speaks LSP with Content-Length framing. This module does
the translation and spawns one zls process per browser connection.
"""
import base64
import hashlib
import json
import os
import shutil
import signal
import socket
import struct
import subprocess
import sys
import threading

DEBUG = bool(os.environ.get("LSP_DEBUG"))

def dbg(*a):
    if DEBUG:
        print("[lsp]", *a, file=sys.stderr, flush=True)

GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
ROOT = os.path.dirname(os.path.abspath(__file__))
ZLS = os.environ.get("ZLS_EXE") or shutil.which("zls") or "zls"
RUNS = os.path.join(ROOT, "work", "runs")


def _recv_exact(rfile, n):
    buf = b""
    while len(buf) < n:
        chunk = rfile.read(n - len(buf))
        if not chunk:
            raise ConnectionError("socket closed")
        buf += chunk
    return buf


def read_ws_frame(rfile):
    """Returns (opcode, payload) or None on close."""
    b1, b2 = _recv_exact(rfile, 2)
    opcode = b1 & 0x0F
    masked = b2 & 0x80
    length = b2 & 0x7F
    if length == 126:
        length = struct.unpack(">H", _recv_exact(rfile, 2))[0]
    elif length == 127:
        length = struct.unpack(">Q", _recv_exact(rfile, 8))[0]
    mask = _recv_exact(rfile, 4) if masked else b"\x00\x00\x00\x00"
    payload = bytearray(_recv_exact(rfile, length))
    if masked:
        for i in range(length):
            payload[i] ^= mask[i % 4]
    return opcode, bytes(payload)


def send_ws_frame(wfile, opcode, payload):
    header = bytearray([0x80 | opcode])
    n = len(payload)
    if n < 126:
        header.append(n)
    elif n < 65536:
        header.append(126)
        header += struct.pack(">H", n)
    else:
        header.append(127)
        header += struct.pack(">Q", n)
    wfile.write(bytes(header) + payload)
    wfile.flush()


class LspBridge:
    """Handles one upgraded /lsp connection."""

    def __init__(self, handler):
        self.handler = handler
        self.rfile, self.wfile = handler.rfile, handler.wfile
        self.zls = None

    def handshake(self):
        key = self.handler.headers.get("Sec-WebSocket-Key", "")
        accept = base64.b64encode(hashlib.sha1((key + GUID).encode()).digest()).decode()
        self.wfile.write(
            b"HTTP/1.1 101 Switching Protocols\r\n"
            b"Upgrade: websocket\r\nConnection: Upgrade\r\n"
            b"Sec-WebSocket-Accept: " + accept.encode() + b"\r\n\r\n")
        self.wfile.flush()

    def start(self):
        env = {**os.environ}
        self.zls = subprocess.Popen(
            [ZLS, "--config-path", os.path.join(RUNS, "zls.json")],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            cwd=RUNS, env=env)
        # drain zls stderr so the pipe never fills and blocks it
        threading.Thread(target=lambda: [None for _ in iter(self.zls.stderr.readline, b"")],
                         daemon=True).start()
        threading.Thread(target=self._zls_to_ws, daemon=True).start()
        try:
            while True:
                frame = read_ws_frame(self.rfile)
                if frame is None:
                    break
                opcode, payload = frame
                if opcode == 0x8:  # close
                    break
                if opcode == 0x9:  # ping -> pong
                    send_ws_frame(self.wfile, 0xA, payload)
                    continue
                if opcode in (0x1, 0x2):
                    self._ws_to_zls(payload)
        except (ConnectionError, OSError):
            pass
        finally:
            self.stop()

    def _ws_to_zls(self, payload):
        if not self.zls:
            return
        body = payload.decode("utf-8", "replace").encode("utf-8")
        msg = b"Content-Length: " + str(len(body)).encode() + b"\r\n\r\n" + body
        try:
            self.zls.stdin.write(msg)
            self.zls.stdin.flush()
            dbg("-> zls", len(body), body[:80])
        except (BrokenPipeError, OSError, AttributeError) as e:
            dbg("-> zls FAILED", e)

    def _zls_to_ws(self):
        """Read LSP frames from zls stdout, forward as WS text frames."""
        zls = self.zls
        if not zls:
            return
        rfile = zls.stdout
        dbg("zls reader started pid=", zls.pid)
        try:
            while True:
                headers = {}
                line = rfile.readline()
                dbg("zls line:", line[:60])
                if not line:
                    dbg("zls EOF")
                    break
                if line in (b"\r\n", b"\n"):
                    continue
                while line not in (b"\r\n", b"\n", b""):
                    k, _, v = line.decode("ascii", "replace").partition(":")
                    headers[k.strip().lower()] = v.strip()
                    line = rfile.readline()
                length = int(headers.get("content-length", 0))
                if not length:
                    continue
                body = _recv_exact(rfile, length)
                send_ws_frame(self.wfile, 0x1, body)
        except (OSError, ValueError):
            pass

    def stop(self):
        zls = self.zls
        self.zls = None
        if zls:
            try:
                zls.stdin.close()
                zls.terminate()
                zls.wait(timeout=2)
            except OSError:
                pass
