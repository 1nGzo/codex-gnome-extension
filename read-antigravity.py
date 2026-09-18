#!/usr/bin/env python3
"""Read quota from the running default Antigravity profile, without exporting auth.

The CSRF token stays in this short-lived process. Only normalized quota is printed.
No login, account switching, remote credential requests, or session reads.
"""
import datetime
import http.client
import json
import os
from pathlib import Path
import sys


def arguments(pid):
    return (Path('/proc') / str(pid) / 'cmdline').read_bytes().decode().split('\0')[:-1]


def option(args, name):
    for i, arg in enumerate(args):
        if arg == name and i + 1 < len(args):
            return args[i + 1]
        if arg.startswith(name + '='):
            return arg[len(name) + 1:]
    return None


def default_profile(pid):
    # The nearest app ancestor owns this LS. Do not climb through an alternate
    # profile to a different app instance (one can launch the other).
    for _ in range(12):
        path = Path('/proc') / str(pid)
        args = arguments(pid)
        if args and Path(args[0]).name == 'antigravity':
            return not option(args, '--user-data-dir') and not option(args, '--profile-directory')
        pid = int(path.joinpath('stat').read_text().rsplit(')', 1)[1].split()[1])
        if pid <= 1:
            break
    return False


def local_server():
    candidates = []
    for path in Path('/proc').iterdir():
        if not path.name.isdecimal():
            continue
        try:
            if path.stat().st_uid != os.getuid():
                continue
            args = arguments(path.name)
            if not args or Path(args[0]).name != 'language_server':
                continue
            if option(args, '--app_data_dir') != 'antigravity' or not default_profile(path.name):
                continue
            token = option(args, '--csrf_token')
            if token:
                candidates.append((path, token))
        except (OSError, ValueError, IndexError, UnicodeError):
            continue
    # An ambiguous default instance is unavailable, never an arbitrary account.
    if len(candidates) != 1:
        raise ValueError('Default Antigravity instance unavailable or ambiguous')
    return candidates[0]


def ports(path):
    sockets = set()
    for fd in path.joinpath('fd').iterdir():
        try:
            link = os.readlink(fd)
            if link.startswith('socket:['):
                sockets.add(link[8:-1])
        except OSError:
            continue
    found = []
    for line in path.joinpath('net/tcp').read_text().splitlines()[1:]:
        fields = line.split()
        address, port = fields[1].split(':')
        if fields[3] == '0A' and fields[9] in sockets and address == '0100007F':
            found.append(int(port, 16))
    return sorted(found)


def normalize(summary):
    groups = summary.get('groups')
    if not isinstance(groups, list) or not groups:
        raise ValueError('Quota groups unavailable')
    windows = []
    now = datetime.datetime.now(datetime.timezone.utc).timestamp()
    for kind, minutes in [('weekly', 10080), ('5h', 300)]:
        readings = []
        for group in groups:
            for bucket in group.get('buckets', []):
                if bucket.get('window') != kind:
                    continue
                remaining = bucket.get('remainingFraction')
                if type(remaining) not in (int, float) or not 0 <= remaining <= 1:
                    raise ValueError('Invalid quota fraction')
                reset = datetime.datetime.fromisoformat(bucket['resetTime'].replace('Z', '+00:00')).timestamp()
                if reset <= now:
                    raise ValueError('Expired quota response')
                readings.append({
                    'usedPercent': (1 - remaining) * 100,
                    'windowMinutes': minutes,
                    'resetsAt': reset,
                    'label': str(group.get('displayName', 'Model group'))[:120],
                })
        if readings:
            windows.append(max(readings, key=lambda w: w['usedPercent']))
    if not windows:
        raise ValueError('Quota windows unavailable')
    return {'windows': windows}


def read():
    path, token = local_server()
    for port in ports(path):
        connection = http.client.HTTPConnection('127.0.0.1', port, timeout=3)
        try:
            connection.request('POST',
                '/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary',
                body='{"forceRefresh":true}',
                headers={'Content-Type': 'application/json', 'x-codeium-csrf-token': token})
            response = connection.getresponse()
            if response.status == 200:
                return normalize(json.loads(response.read(1024 * 1024))['response'])
        except (OSError, ValueError, KeyError, TypeError, http.client.HTTPException):
            continue
        finally:
            connection.close()
    raise ValueError('Quota endpoint unavailable')


if __name__ == '__main__':
    try:
        print(json.dumps(read(), allow_nan=False))
    except Exception:
        # Never echo process arguments, tokens, account identity or raw responses.
        print('null')
        sys.exit(1)
