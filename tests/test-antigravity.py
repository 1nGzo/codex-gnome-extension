import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch, MagicMock

spec = importlib.util.spec_from_file_location('adapter', Path(__file__).resolve().parents[1] / 'read-antigravity.py')
a = importlib.util.module_from_spec(spec)
spec.loader.exec_module(a)

class Failures(unittest.TestCase):
    def test_categories(self):
        with patch.object(a, 'local_server', side_effect=a.Unavailable('process unavailable')):
            with self.assertRaisesRegex(a.Unavailable, '^process unavailable$'): a.read()
        with patch.object(a, 'local_server', return_value=(Path('/unused'), 'fixture-only')):
            with patch.object(a, 'ports', return_value=[]):
                with self.assertRaisesRegex(a.Unavailable, '^port unavailable$'): a.read()
            with patch.object(a, 'ports', return_value=[12345]):
                with patch.object(a.http.client, 'HTTPConnection') as factory:
                    response = factory.return_value.getresponse.return_value
                    response.status = 404
                    with self.assertRaisesRegex(a.Unavailable, '^rpc unavailable$'): a.read()
                    response.status = 200
                    response.read.return_value = b'{"response":{"groups":[]}}'
                    with self.assertRaisesRegex(a.Unavailable, '^invalid quota response$'): a.read()
                    response.read.return_value = b'{"response":null}'
                    with self.assertRaisesRegex(a.Unavailable, '^invalid quota response$'): a.read()

unittest.main()
