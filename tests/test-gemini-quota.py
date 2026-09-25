#!/usr/bin/env python3
"""Targeted unit tests for Antigravity Gemini quota filtering and mapping.

Covers:
1. Gemini 55/14 + ClaudeGPT 46/100
   -> Extracts Gemini weekly (55% remaining) and 5h (14% remaining)
   -> Claude/GPT completely ignored and excluded from windows
2. Missing Gemini group (only Claude/GPT present)
   -> Raises ValueError / unavailable
   -> Never falls back to Claude/GPT 46/100
3. Stable identification via bucketId and fallback displayName
4. Full read() flow with default profile and multi-profile isolation
"""
import datetime
import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import patch, MagicMock

spec = importlib.util.spec_from_file_location('adapter', Path(__file__).resolve().parents[1] / 'read-antigravity.py')
a = importlib.util.module_from_spec(spec)
spec.loader.exec_module(a)


class TestGeminiQuotaFiltering(unittest.TestCase):
    def setUp(self):
        # Reset times in future
        future_weekly = (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(days=4, hours=4)).isoformat().replace('+00:00', 'Z')
        future_5h = (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(minutes=50)).isoformat().replace('+00:00', 'Z')

        # Real fixture with Gemini (55% weekly, 14% 5h) and Claude/GPT (46% weekly, 100% 5h)
        self.mixed_summary = {
            'groups': [
                {
                    'displayName': 'Gemini Models',
                    'description': 'Models within this group: Gemini Flash, Gemini Pro',
                    'buckets': [
                        {
                            'bucketId': 'gemini-weekly',
                            'displayName': 'Weekly Limit Remaining',
                            'window': 'weekly',
                            'remainingFraction': 0.55,
                            'resetTime': future_weekly,
                        },
                        {
                            'bucketId': 'gemini-5h',
                            'displayName': 'Five Hour Limit Remaining',
                            'window': '5h',
                            'remainingFraction': 0.14,
                            'resetTime': future_5h,
                        },
                    ],
                },
                {
                    'displayName': 'Claude and GPT models',
                    'description': 'Models within this group: Claude Opus, Claude Sonnet, GPT-OSS',
                    'buckets': [
                        {
                            'bucketId': '3p-weekly',
                            'displayName': 'Weekly Limit Remaining',
                            'window': 'weekly',
                            'remainingFraction': 0.46,
                            'resetTime': future_weekly,
                        },
                        {
                            'bucketId': '3p-5h',
                            'displayName': 'Five Hour Limit Remaining',
                            'window': '5h',
                            'remainingFraction': 1.0,
                            'resetTime': future_5h,
                        },
                    ],
                },
            ]
        }

        # Fixture with ONLY Claude/GPT (Gemini group missing)
        self.missing_gemini_summary = {
            'groups': [
                {
                    'displayName': 'Claude and GPT models',
                    'description': 'Models within this group: Claude Opus, Claude Sonnet, GPT-OSS',
                    'buckets': [
                        {
                            'bucketId': '3p-weekly',
                            'displayName': 'Weekly Limit Remaining',
                            'window': 'weekly',
                            'remainingFraction': 0.46,
                            'resetTime': future_weekly,
                        },
                        {
                            'bucketId': '3p-5h',
                            'displayName': 'Five Hour Limit Remaining',
                            'window': '5h',
                            'remainingFraction': 1.0,
                            'resetTime': future_5h,
                        },
                    ],
                },
            ]
        }

    def test_gemini_extraction_ignores_claude_gpt(self):
        """Gemini 55/14 + ClaudeGPT 46/100 -> only Gemini windows extracted, no cross-contamination."""
        result = a.normalize(self.mixed_summary)
        windows = result['windows']
        self.assertEqual(len(windows), 2)

        weekly = next((w for w in windows if w['windowMinutes'] == 10080), None)
        five_hour = next((w for w in windows if w['windowMinutes'] == 300), None)

        self.assertIsNotNone(weekly)
        self.assertIsNotNone(five_hour)

        # Weekly remaining is 55% -> usedPercent is 45.0%
        self.assertAlmostEqual(weekly['usedPercent'], 45.0, places=1)
        # 5-hour remaining is 14% -> usedPercent is 86.0%
        self.assertAlmostEqual(five_hour['usedPercent'], 86.0, places=1)

        # Labels must identify Gemini, never Claude/GPT
        self.assertIn('Gemini', weekly['label'])
        self.assertIn('Gemini', five_hour['label'])
        for w in windows:
            self.assertNotIn('Claude', w['label'])
            self.assertNotIn('GPT', w['label'])

    def test_gemini_reversed_order_group_selection(self):
        """Even if Claude/GPT appears first in groups list, Gemini is strictly selected."""
        reversed_summary = {
            'groups': list(reversed(self.mixed_summary['groups']))
        }
        result = a.normalize(reversed_summary)
        windows = result['windows']
        self.assertEqual(len(windows), 2)

        weekly = next((w for w in windows if w['windowMinutes'] == 10080), None)
        five_hour = next((w for w in windows if w['windowMinutes'] == 300), None)

        self.assertAlmostEqual(weekly['usedPercent'], 45.0, places=1)
        self.assertAlmostEqual(five_hour['usedPercent'], 86.0, places=1)

    def test_gemini_missing_raises_and_never_falls_back_to_claude_gpt(self):
        """Missing Gemini group -> raises ValueError, does not fall back to Claude/GPT 46/100."""
        with self.assertRaisesRegex(ValueError, 'Gemini quota unavailable'):
            a.normalize(self.missing_gemini_summary)

        # Empty groups list also raises
        with self.assertRaises(ValueError):
            a.normalize({'groups': []})

    def test_is_gemini_group_identification(self):
        """Tests stable RPC identification via bucketId and fallback."""
        # 1. Identified by bucketId
        g1 = {
            'displayName': 'Custom Display Name',
            'buckets': [{'bucketId': 'gemini-weekly', 'window': 'weekly'}]
        }
        self.assertTrue(a.is_gemini_group(g1))

        # 2. Identified by group displayName fallback
        g2 = {
            'displayName': 'Gemini Models',
            'buckets': [{'window': 'weekly'}]
        }
        self.assertTrue(a.is_gemini_group(g2))

        # 3. Third-party bucketId rejected even with ambiguous displayName
        g3 = {
            'displayName': 'Gemini and Claude',
            'buckets': [{'bucketId': '3p-weekly', 'window': 'weekly'}]
        }
        self.assertFalse(a.is_gemini_group(g3))

        # 4. Standard 3p group rejected
        g4 = self.missing_gemini_summary['groups'][0]
        self.assertFalse(a.is_gemini_group(g4))

    def test_query_quota_failure_when_gemini_missing(self):
        """query_quota returns None and invalid quota response when Gemini missing."""
        with patch.object(a, 'ports', return_value=[9999]):
            with patch.object(a.http.client, 'HTTPConnection') as conn_mock:
                response = conn_mock.return_value.getresponse.return_value
                response.status = 200
                response.read.return_value = json.dumps({'response': self.missing_gemini_summary}).encode()

                quota, err = a.query_quota(Path('/proc/123'), 'test-token')
                self.assertIsNone(quota)
                self.assertEqual(err, 'invalid quota response')

    def test_read_flow_with_mixed_and_missing_profiles(self):
        """read() produces Gemini quota for online profiles, and empty windows without Claude/GPT fallback."""
        mock_profiles = [
            {'id': 'default', 'name': 'Default', 'home': '/home/default', 'is_default': True, 'hasAuth': True},
            {'id': 'antigravity-b', 'name': 'Antigravity B', 'home': '/home/b', 'is_default': False, 'hasAuth': True},
        ]
        running = {
            '/home/default': (Path('/proc/100'), 'token-default'),
            '/home/b': (Path('/proc/200'), 'token-b'),
        }

        def mock_query(proc_path, token):
            if token == 'token-default':
                return a.normalize(self.mixed_summary), None
            elif token == 'token-b':
                # Profile B has running server, but Gemini group is missing in response
                try:
                    return a.normalize(self.missing_gemini_summary), None
                except ValueError:
                    return None, 'invalid quota response'
            return None, 'port unavailable'

        with patch.object(a, 'discover_profiles', return_value=mock_profiles):
            with patch.object(a, 'discover_running_servers', return_value=running):
                with patch.object(a, 'query_quota', side_effect=mock_query):
                    result = a.read()

        # Default profile: has Gemini quota
        prof_default = result['profiles'][0]
        self.assertEqual(prof_default['id'], 'default')
        self.assertEqual(prof_default['status'], 'online')
        self.assertEqual(len(prof_default['windows']), 2)
        # Weekly: 45% used (55% remaining)
        self.assertAlmostEqual(prof_default['windows'][0]['usedPercent'], 45.0, places=1)
        # Root windows matches default profile
        self.assertEqual(result['windows'], prof_default['windows'])

        # Profile B: online server, but Gemini missing -> status online, empty windows, error recorded
        prof_b = result['profiles'][1]
        self.assertEqual(prof_b['id'], 'antigravity-b')
        self.assertEqual(prof_b['status'], 'online')
        self.assertEqual(prof_b['windows'], [])
        self.assertEqual(prof_b['error'], 'invalid quota response')


if __name__ == '__main__':
    unittest.main()
