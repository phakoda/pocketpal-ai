import http.client
import json
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from server import Bridge, arguments


class ArgumentsTests(unittest.TestCase):
    def test_note_is_one_argv_even_with_shell_metacharacters(self):
        self.assertEqual(arguments({'operation': 'note', 'text': '$(echo unsafe); "x"'}),
                         ['note', '$(echo unsafe); "x"'])

    def test_note_utf8_byte_boundary(self):
        self.assertEqual(arguments({'operation': 'note', 'text': 'é' * 140}), ['note', 'é' * 140])
        with self.assertRaises(ValueError):
            arguments({'operation': 'note', 'text': 'é' * 141})

    def test_rejects_multiline_and_empty_note(self):
        for text in ['', '  ', 'hello\nworld', '\x00', 'a\rb']:
            with self.subTest(text=text), self.assertRaises(ValueError):
                arguments({'operation': 'note', 'text': text})

    def test_no_file_or_destructive_commands(self):
        for op in ['init', 'import', 'config', 'forget', 'sh', None]:
            with self.subTest(op=op), self.assertRaises(ValueError):
                arguments({'operation': op, 'text': '/etc/passwd'})

    def test_block_ids_and_merges(self):
        self.assertEqual(arguments({'operation': 'nap'}), ['nap'])
        self.assertEqual(arguments({'operation': 'nap', 'block': '0-1', 'text': 'fact'}),
                         ['nap', '0-1', 'fact'])
        for value in ['-1-2', '1-1', '2-1', '0-1;exit', '../0-1']:
            with self.subTest(value=value), self.assertRaises(ValueError):
                arguments({'operation': 'zoom', 'block': value})

    def test_wake_page(self):
        self.assertEqual(arguments({'operation': 'wake'}), ['wake', '1'])
        for part in [True, 0, -1, '2', 2.5]:
            with self.subTest(part=part), self.assertRaises(ValueError):
                arguments({'operation': 'wake', 'part': part})

    def test_recall_limits(self):
        self.assertEqual(arguments({'operation': 'recall', 'pattern': 'food|drink'}),
                         ['recall', 'food|drink'])
        with self.assertRaises(ValueError):
            arguments({'operation': 'recall', 'pattern': 'a' * 257})


class HTTPTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        executable = Path(self.tmp.name, 'memo')
        executable.write_text('placeholder', encoding='utf-8')
        self.server = Bridge(('127.0.0.1', 0), executable, self.tmp.name, 'x' * 32)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.tmp.cleanup()

    def request(self, payload, token='x' * 32):
        connection = http.client.HTTPConnection(*self.server.server_address, timeout=2)
        connection.request('POST', '/v1/memo', json.dumps(payload),
                           {'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
        response = connection.getresponse()
        result = response.status, json.loads(response.read())
        connection.close()
        return result

    @patch('server.subprocess.run')
    def test_unauthenticated_request_never_runs_cli(self, run):
        self.assertEqual(self.request({'operation': 'wake'}, token='wrong')[0], 401)
        run.assert_not_called()

    @patch('server.subprocess.run')
    def test_bad_command_never_runs_cli(self, run):
        self.assertEqual(self.request({'operation': 'import', 'text': '/secret'})[0], 400)
        run.assert_not_called()

    @patch('server.subprocess.run')
    def test_authenticated_call_and_output(self, run):
        def output(_argv, **kwargs):
            self.assertFalse(kwargs['shell'])
            self.assertNotIn('OPTMEM_TOKEN', kwargs['env'])
            kwargs['stdout'].write(b'#0 a memory')
            class Result:
                returncode = 0
            return Result()
        run.side_effect = output
        self.assertEqual(self.request({'operation': 'wake'}),
                         (200, {'output': '#0 a memory', 'truncated': False}))


if __name__ == '__main__':
    unittest.main()
