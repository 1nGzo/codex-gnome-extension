import datetime
import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import patch, MagicMock

spec = importlib.util.spec_from_file_location('adapter', Path(__file__).resolve().parents[1] / 'read-antigravity.py')
a = importlib.util.module_from_spec(spec)
spec.loader.exec_module(a)

class Failures(unittest.TestCase):
    def test_categories(self):
        # When no profiles have auth and no servers running
        with patch.object(a, 'discover_profiles', return_value=[]):
            with patch.object(a, 'discover_running_servers', return_value={}):
                with self.assertRaisesRegex(a.Unavailable, '^process unavailable$'):
                    a.read()

        # Test query_quota failures
        with patch.object(a, 'ports', return_value=[]):
            quota, err = a.query_quota(Path('/unused'), 'fixture-only')
            self.assertIsNone(quota)
            self.assertEqual(err, 'port unavailable')

        with patch.object(a, 'ports', return_value=[12345]):
            with patch.object(a.http.client, 'HTTPConnection') as factory:
                response = factory.return_value.getresponse.return_value

                response.status = 404
                quota, err = a.query_quota(Path('/unused'), 'fixture-only')
                self.assertIsNone(quota)
                self.assertEqual(err, 'rpc unavailable')

                response.status = 200
                response.read.return_value = b'{"response":{"groups":[]}}'
                quota, err = a.query_quota(Path('/unused'), 'fixture-only')
                self.assertIsNone(quota)
                self.assertEqual(err, 'invalid quota response')

                response.read.return_value = b'{"response":null}'
                quota, err = a.query_quota(Path('/unused'), 'fixture-only')
                self.assertIsNone(quota)
                self.assertEqual(err, 'invalid quota response')

    def test_refresh_failure_keeps_cached_summary(self):
        future = (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(hours=2)).strftime('%Y-%m-%dT%H:%M:%SZ')
        payload = json.dumps({'response': {'groups': [{
            'displayName': 'Gemini Models',
            'buckets': [{
                'bucketId': 'gemini-weekly',
                'window': 'weekly',
                'remainingFraction': 0.7,
                'resetTime': future,
            }],
        }]}}).encode()
        bodies = []

        def request(method, path, body=None, headers=None):
            bodies.append(body)
            if body == '{"forceRefresh":true}':
                raise TimeoutError('timed out')

        with patch.object(a, 'ports', return_value=[36933]):
            with patch.object(a.http.client, 'HTTPConnection') as factory:
                factory.return_value.request.side_effect = request
                response = factory.return_value.getresponse.return_value
                response.status = 200
                response.read.return_value = payload
                quota, err = a.query_quota(Path('/unused'), 'fixture-only')

                self.assertIsNone(err)
                self.assertEqual(bodies, ['{"forceRefresh":false}', '{"forceRefresh":true}'])
                self.assertAlmostEqual(quota['windows'][0]['usedPercent'], 30.0, places=1)

                bodies.clear()
                cache_response = MagicMock(status=200)
                cache_response.read.return_value = payload
                refresh_response = MagicMock(status=500)
                refresh_response.read.return_value = b'upstream eof'
                factory.return_value.request.side_effect = lambda *args, **kwargs: bodies.append(
                    kwargs.get('body') if 'body' in kwargs else (args[2] if len(args) > 2 else None))
                factory.return_value.getresponse.side_effect = [cache_response, refresh_response]
                quota, err = a.query_quota(Path('/unused'), 'fixture-only')
                self.assertIsNone(err)
                self.assertEqual(bodies, ['{"forceRefresh":false}', '{"forceRefresh":true}'])
                self.assertAlmostEqual(quota['windows'][0]['usedPercent'], 30.0, places=1)

unittest.main()
