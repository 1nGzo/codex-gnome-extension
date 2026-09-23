import importlib.util
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

unittest.main()
