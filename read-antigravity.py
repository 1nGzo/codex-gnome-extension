#!/usr/bin/env python3
"""Read quota from running Antigravity profile(s), without exporting auth.

The CSRF token stays in this short-lived process. Only normalized quota or a fixed failure category is printed.
No login, account switching, remote credential requests, or session reads.
"""
import datetime
import glob
import http.client
import json
import os
from pathlib import Path
import subprocess
import sys


class Unavailable(Exception):
    pass


def arguments(pid):
    return (Path('/proc') / str(pid) / 'cmdline').read_bytes().decode().split('\0')[:-1]


def option(args, name):
    for i, arg in enumerate(args):
        if arg == name and i + 1 < len(args):
            return args[i + 1]
        if arg.startswith(name + '='):
            return arg[len(name) + 1:]
    return None


def get_proc_home(pid):
    try:
        env_bytes = (Path('/proc') / str(pid) / 'environ').read_bytes()
        for item in env_bytes.split(b'\0'):
            if item.startswith(b'HOME='):
                return item[5:].decode(errors='replace')
    except Exception:
        pass
    return None


def check_default_auth():
    # Only verify credential existence in Secret Service without reading or outputting secret content.
    try:
        import dbus
        bus = dbus.SessionBus()
        service = bus.get_object('org.freedesktop.secrets', '/org/freedesktop/secrets')
        iface = dbus.Interface(service, 'org.freedesktop.Secret.Service')
        unlocked, locked = iface.SearchItems({'service': 'gemini', 'username': 'antigravity'})
        if len(unlocked) > 0 or len(locked) > 0:
            return True
    except Exception:
        pass

    try:
        out = subprocess.check_output([
            'gdbus', 'call', '--session',
            '--dest', 'org.freedesktop.secrets',
            '--object-path', '/org/freedesktop/secrets',
            '--method', 'org.freedesktop.Secret.Service.SearchItems',
            "{'service': 'gemini', 'username': 'antigravity'}"
        ], stderr=subprocess.DEVNULL, timeout=2).decode()
        if 'objectpath' in out:
            return True
    except Exception:
        pass

    return False


def check_extra_auth(profile_home):
    # Only check file existence without reading or outputting token content.
    token_file = Path(profile_home) / '.gemini' / 'jetski-standalone-oauth-token'
    try:
        return token_file.is_file() and token_file.stat().st_size > 0
    except Exception:
        return False


def discover_profiles():
    real_home = str(Path.home().resolve())
    profiles = []

    # Default profile
    profiles.append({
        'id': 'default',
        'name': 'Default',
        'home': real_home,
        'is_default': True,
        'hasAuth': check_default_auth(),
    })

    # Extra profiles: ~/.config/antigravity-*/home
    config_dir = Path.home() / '.config'
    if config_dir.is_dir():
        for p_dir in sorted(config_dir.glob('antigravity-*/home')):
            parent_name = p_dir.parent.name
            suffix = parent_name.split('-', 1)[1] if '-' in parent_name else parent_name
            display_name = f'Antigravity {suffix.upper()}'
            p_home = str(p_dir.resolve())
            profiles.append({
                'id': parent_name,
                'name': display_name,
                'home': p_home,
                'is_default': False,
                'hasAuth': check_extra_auth(p_home),
            })

    return profiles


def discover_running_servers():
    servers_by_home = {}
    for path in Path('/proc').iterdir():
        if not path.name.isdecimal():
            continue
        try:
            if path.stat().st_uid != os.getuid():
                continue
            args = arguments(path.name)
            if not args or Path(args[0]).name != 'language_server':
                continue
            if option(args, '--app_data_dir') != 'antigravity':
                continue
            token = option(args, '--csrf_token')
            if not token:
                continue
            p_home = get_proc_home(path.name)
            if not p_home:
                continue
            p_home_resolved = str(Path(p_home).resolve())
            servers_by_home[p_home_resolved] = (path, token)
        except (OSError, ValueError, IndexError, UnicodeError):
            continue
    return servers_by_home


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


def query_quota(proc_path, token):
    try:
        discovered = ports(proc_path)
    except OSError:
        discovered = []
    if not discovered:
        return None, 'port unavailable'
    failure = 'rpc unavailable'
    for port in discovered:
        connection = http.client.HTTPConnection('127.0.0.1', port, timeout=3)
        try:
            connection.request(
                'POST',
                '/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary',
                body='{"forceRefresh":true}',
                headers={'Content-Type': 'application/json', 'x-codeium-csrf-token': token}
            )
            response = connection.getresponse()
            if response.status == 200:
                try:
                    return normalize(json.loads(response.read(1024 * 1024))['response']), None
                except (ValueError, KeyError, TypeError, AttributeError, OverflowError):
                    failure = 'invalid quota response'
        except (OSError, ValueError, KeyError, TypeError, http.client.HTTPException):
            continue
        finally:
            connection.close()
    return None, failure


def read():
    profiles_info = discover_profiles()
    running_servers = discover_running_servers()

    results = []
    default_windows = []
    has_any_online = False
    has_any_auth = False

    for p in profiles_info:
        p_home = p['home']
        has_auth = p['hasAuth']
        if has_auth:
            has_any_auth = True

        server_candidate = running_servers.get(p_home)
        if server_candidate:
            proc_path, token = server_candidate
            quota, err = query_quota(proc_path, token)
            if quota:
                has_any_online = True
                profile_entry = {
                    'id': p['id'],
                    'name': p['name'],
                    'status': 'online',
                    'hasAuth': has_auth,
                    'windows': quota['windows'],
                }
                if p['is_default']:
                    default_windows = quota['windows']
            else:
                profile_entry = {
                    'id': p['id'],
                    'name': p['name'],
                    'status': 'online',
                    'hasAuth': has_auth,
                    'windows': [],
                    'error': err,
                }
        else:
            profile_entry = {
                'id': p['id'],
                'name': p['name'],
                'status': 'offline',
                'hasAuth': has_auth,
                'windows': [],
            }
        results.append(profile_entry)

    if not has_any_online and not has_any_auth:
        raise Unavailable('process unavailable')

    return {
        'windows': default_windows,
        'profiles': results,
    }


if __name__ == '__main__':
    try:
        print(json.dumps(read(), allow_nan=False))
    except Unavailable as error:
        print(json.dumps({'error': str(error)}))
        sys.exit(1)
    except Exception:
        # Never echo process arguments, tokens, account identity or raw responses.
        print(json.dumps({'error': 'rpc unavailable'}))
        sys.exit(1)
