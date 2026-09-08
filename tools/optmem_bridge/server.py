#!/usr/bin/env python3
"""Authenticated adapter to a separately installed OptMem CLI (not a reimplementation).

Initialize OptMem as its operator first. Bind behind an HTTPS reverse proxy.
No upstream OptMem source is bundled or imported by this adapter.
"""
import hmac
import json
import os
import re
import subprocess
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

MAX_BODY = 16384
MAX_OUTPUT = 24000
LOCK = threading.Lock()


def note(value):
    if not isinstance(value, str) or not value.strip():
        raise ValueError('A non-empty note is required.')
    if any(c in value for c in ('\n', '\r', '\x00')):
        raise ValueError('Notes must be a single line.')
    if len(value.encode('utf-8')) > 280:
        raise ValueError('Notes and summaries may contain at most 280 UTF-8 bytes.')
    return value


def block(value):
    if not isinstance(value, str) or not re.fullmatch(r'[0-9]{1,10}-[0-9]{1,10}', value):
        raise ValueError('Expected an OptMem block ID, e.g. 0-1.')
    lo, hi = map(int, value.split('-'))
    if hi <= lo:
        raise ValueError('The block end must be greater than its start.')
    return value


def arguments(payload):
    """Only typed memory operations, never arbitrary commands, paths or flags."""
    if not isinstance(payload, dict):
        raise ValueError('Expected an object.')
    op = payload.get('operation')
    if op == 'wake':
        part = payload.get('part', 1)
        if type(part) is not int or not 1 <= part <= 1000000:
            raise ValueError('part must be a positive integer.')
        return ['wake', str(part)]
    if op == 'note':
        return ['note', note(payload.get('text'))]
    if op == 'recall':
        pattern = payload.get('pattern')
        if not isinstance(pattern, str) or not 1 <= len(pattern) <= 256 or '\x00' in pattern:
            raise ValueError('Expected a regex of 1-256 characters.')
        return ['recall', pattern]
    if op == 'zoom':
        return ['zoom', block(payload.get('block'))]
    if op == 'nap':
        if payload.get('block') is None and payload.get('text') is None:
            return ['nap']
        return ['nap', block(payload.get('block')), note(payload.get('text'))]
    raise ValueError('Allowed operations: wake, note, recall, zoom, nap.')


class Bridge(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address, executable, memory_dir, token):
        if not isinstance(token, str) or len(token) < 32 or not token.isascii():
            raise ValueError('OPTMEM_TOKEN must be at least 32 ASCII characters.')
        self.executable = str(Path(executable).expanduser().resolve(strict=True))
        self.memory_dir = str(Path(memory_dir).expanduser().resolve(strict=True))
        if not Path(self.executable).is_file() or not Path(self.memory_dir).is_dir():
            raise ValueError('Expected an executable file and initialized memory directory.')
        self.token = token.encode('ascii')
        super().__init__(address, Handler)


class Handler(BaseHTTPRequestHandler):
    def setup(self):
        super().setup()
        self.connection.settimeout(15)

    def log_message(self, *_args):
        # Do not log credentials, memory content or request bodies.
        pass

    def reply(self, status, payload):
        body = json.dumps(payload, ensure_ascii=True).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Connection', 'close')
        self.end_headers()
        self.wfile.write(body)
        self.close_connection = True

    def do_POST(self):
        header = self.headers.get('Authorization', '')
        supplied = header[7:] if header.startswith('Bearer ') else ''
        if not hmac.compare_digest(supplied.encode('utf-8'), self.server.token):
            self.reply(401, {'error': 'Authentication required.'})
            return
        if self.path != '/v1/memo':
            self.reply(404, {'error': 'Not found.'})
            return
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= MAX_BODY or self.headers.get('Transfer-Encoding'):
                raise ValueError('Request is too large or has no content length.')
            raw = self.rfile.read(length)
            if len(raw) != length:
                raise ValueError('Incomplete request.')
            argv = arguments(json.loads(raw))
        except (ValueError, UnicodeError):
            self.reply(400, {'error': 'Invalid memory operation or arguments.'})
            return
        if not LOCK.acquire(timeout=2):
            self.reply(429, {'error': 'Memory is busy. Try again.'})
            return
        try:
            env = dict(os.environ, MEMORY_DIR=self.server.memory_dir)
            # Do not pass the bridge's bearer token to the CLI's environment.
            env.pop('OPTMEM_TOKEN', None)
            with tempfile.TemporaryFile() as output:
                result = subprocess.run(
                    [self.server.executable, *argv], shell=False,
                    stdin=subprocess.DEVNULL, stdout=output,
                    stderr=subprocess.DEVNULL, env=env, timeout=10, check=False,
                )
                output.seek(0)
                text = output.read(MAX_OUTPUT + 1)
            if result.returncode:
                self.reply(422, {'error': 'OptMem rejected the operation. Check initialization and arguments.'})
            else:
                self.reply(200, {
                    'output': text[:MAX_OUTPUT].decode('utf-8', errors='replace'),
                    'truncated': len(text) > MAX_OUTPUT,
                })
        except subprocess.TimeoutExpired:
            # Never automatically retry a write: its outcome may be unknown.
            self.reply(504, {'error': 'OptMem timed out. Verify with recall before retrying a note.'})
        except OSError:
            self.reply(503, {'error': 'OptMem executable or memory is unavailable.'})
        finally:
            LOCK.release()


def main():
    server = Bridge(
        (os.environ.get('OPTMEM_HOST', '127.0.0.1'), int(os.environ.get('OPTMEM_PORT', '8377'))),
        os.environ.get('OPTMEM_EXECUTABLE', '~/.optmem/memo'),
        os.environ.get('MEMORY_DIR', '~/.optmem/memory'),
        os.environ.get('OPTMEM_TOKEN', ''),
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
