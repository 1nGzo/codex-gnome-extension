#!/usr/bin/env python3
import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import patch, MagicMock

spec = importlib.util.spec_from_file_location('adapter', Path(__file__).resolve().parents[1] / 'read-antigravity.py')
a = importlib.util.module_from_spec(spec)
spec.loader.exec_module(a)


class TestMultiProfileDiscovery(unittest.TestCase):
    def setUp(self):
        self.mock_profiles = [
            {'id': 'default', 'name': 'Default', 'home': '/home/user', 'is_default': True, 'hasAuth': True},
            {'id': 'antigravity-b', 'name': 'Antigravity B', 'home': '/home/user/.config/antigravity-b/home', 'is_default': False, 'hasAuth': True},
        ]
        self.sample_quota_a = {
            'windows': [
                {'usedPercent': 30.0, 'windowMinutes': 10080, 'resetsAt': 1790000000, 'label': 'Gemini Models'},
                {'usedPercent': 10.0, 'windowMinutes': 300, 'resetsAt': 1790001000, 'label': 'Gemini Models'},
            ]
        }
        self.sample_quota_b = {
            'windows': [
                {'usedPercent': 60.0, 'windowMinutes': 10080, 'resetsAt': 1790000500, 'label': 'Gemini Models'},
                {'usedPercent': 5.0, 'windowMinutes': 300, 'resetsAt': 1790002000, 'label': 'Gemini Models'},
            ]
        }

    def test_both_profiles_online(self):
        """Scenario 1: Both A and B running -> independent quota, no cross-contamination."""
        running = {
            '/home/user': (Path('/proc/100'), 'csrf-a'),
            '/home/user/.config/antigravity-b/home': (Path('/proc/200'), 'csrf-b'),
        }

        def mock_query(proc_path, token):
            if token == 'csrf-a':
                return self.sample_quota_a, None
            elif token == 'csrf-b':
                return self.sample_quota_b, None
            return None, 'port unavailable'

        with patch.object(a, 'discover_profiles', return_value=self.mock_profiles):
            with patch.object(a, 'discover_running_servers', return_value=running):
                with patch.object(a, 'query_quota', side_effect=mock_query):
                    result = a.read()

        self.assertEqual(len(result['profiles']), 2)
        prof_a = result['profiles'][0]
        prof_b = result['profiles'][1]

        self.assertEqual(prof_a['id'], 'default')
        self.assertEqual(prof_a['status'], 'online')
        self.assertEqual(prof_a['windows'][0]['usedPercent'], 30.0)

        self.assertEqual(prof_b['id'], 'antigravity-b')
        self.assertEqual(prof_b['status'], 'online')
        self.assertEqual(prof_b['windows'][0]['usedPercent'], 60.0)

        # Root windows should correspond to default profile
        self.assertEqual(result['windows'], prof_a['windows'])

    def test_only_a_online_b_offline(self):
        """Scenario 2: Only A is running -> A has quota, B is Detected · Offline."""
        running = {
            '/home/user': (Path('/proc/100'), 'csrf-a'),
        }

        with patch.object(a, 'discover_profiles', return_value=self.mock_profiles):
            with patch.object(a, 'discover_running_servers', return_value=running):
                with patch.object(a, 'query_quota', return_value=(self.sample_quota_a, None)):
                    result = a.read()

        self.assertEqual(len(result['profiles']), 2)
        prof_a = result['profiles'][0]
        prof_b = result['profiles'][1]

        self.assertEqual(prof_a['status'], 'online')
        self.assertEqual(len(prof_a['windows']), 2)

        self.assertEqual(prof_b['status'], 'offline')
        self.assertTrue(prof_b['hasAuth'])
        self.assertEqual(prof_b['windows'], [])

    def test_only_b_online_a_offline(self):
        """Scenario 3: Only B is running -> B has quota, A is Detected · Offline."""
        running = {
            '/home/user/.config/antigravity-b/home': (Path('/proc/200'), 'csrf-b'),
        }

        with patch.object(a, 'discover_profiles', return_value=self.mock_profiles):
            with patch.object(a, 'discover_running_servers', return_value=running):
                with patch.object(a, 'query_quota', return_value=(self.sample_quota_b, None)):
                    result = a.read()

        prof_a = result['profiles'][0]
        prof_b = result['profiles'][1]

        self.assertEqual(prof_a['status'], 'offline')
        self.assertEqual(prof_b['status'], 'online')
        self.assertEqual(prof_b['windows'][0]['usedPercent'], 60.0)
        # Root windows empty because default profile is offline
        self.assertEqual(result['windows'], [])

    def test_both_offline_with_auth(self):
        """Scenario 4: Neither is running, but auth exists -> returns offline profiles without error."""
        with patch.object(a, 'discover_profiles', return_value=self.mock_profiles):
            with patch.object(a, 'discover_running_servers', return_value={}):
                result = a.read()

        self.assertEqual(len(result['profiles']), 2)
        self.assertEqual(result['profiles'][0]['status'], 'offline')
        self.assertTrue(result['profiles'][0]['hasAuth'])
        self.assertEqual(result['profiles'][1]['status'], 'offline')
        self.assertTrue(result['profiles'][1]['hasAuth'])
        self.assertEqual(result['windows'], [])

    def test_zero_leakage_security_invariant(self):
        """Security invariant: Output payload never contains CSRF tokens, secret keys, or auth credentials."""
        running = {
            '/home/user': (Path('/proc/100'), 'sensitive-csrf-token-12345'),
        }
        with patch.object(a, 'discover_profiles', return_value=self.mock_profiles):
            with patch.object(a, 'discover_running_servers', return_value=running):
                with patch.object(a, 'query_quota', return_value=(self.sample_quota_a, None)):
                    raw_json = json.dumps(a.read())

        for forbidden in ['sensitive-csrf-token', 'csrf', 'token', 'secret', 'password', 'keyring']:
            self.assertNotIn(forbidden, raw_json.lower())


if __name__ == '__main__':
    unittest.main()
