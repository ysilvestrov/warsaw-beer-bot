"""Execute the installer against a file-backed crontab, never the real scheduler."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

INSTALLER = Path(__file__).parents[2] / 'deploy/install-resource-monitor.sh'


class InstallMonitor(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory()
        self.root = Path(self.scratch.name)
        self.home = self.root / 'home'
        self.home.mkdir(mode=0o700)
        self.table = self.root / 'crontab'
        self.original = '# keep this comment\n17 * * * * /usr/bin/true\n'
        self.table.write_text(self.original)
        self.stub = self.root / 'crontab-command'
        self.stub.write_text('#!/usr/bin/env python3\nimport sys,os\nfrom pathlib import Path\n'
                             'p=Path(os.environ["TEST_CRONTAB_FILE"])\n'
                             'if sys.argv[1]=="-l":sys.stdout.write(p.read_text())\n'
                             'else:p.write_text(Path(sys.argv[1]).read_text())\n')
        self.stub.chmod(0o700)
        self.env = dict(os.environ, WBB_OPS_HOME=str(self.home), WBB_CRONTAB=str(self.stub),
                        TEST_CRONTAB_FILE=str(self.table))

    def tearDown(self):
        self.scratch.cleanup()

    def install(self):
        return subprocess.run(['bash', str(INSTALLER)], env=self.env, capture_output=True,
                              text=True, timeout=10)

    def test_install_is_idempotent_and_preserves_unrelated_cron(self):
        first = self.install()
        self.assertEqual(first.returncode, 0, first.stderr)
        second = self.install()
        self.assertEqual(second.returncode, 0, second.stderr)
        table = self.table.read_text()
        self.assertEqual(table[:len(self.original)], self.original)
        self.assertEqual(table.count('# BEGIN wbb-resource-monitor'), 1)
        self.assertEqual(table.count('*/5 * * * *'), 1)
        copies = list((self.home/'.local/lib/wbb-ops').glob('*/resource_monitor.py'))
        self.assertEqual(len(copies), 1)
        wrapper = self.home/'.local/bin/wbb-test'
        self.assertEqual(wrapper.stat().st_mode & 0o777, 0o700)
        state = self.home/'.local/state/wbb-resource-monitor'
        self.assertEqual((state/'crontab.before-install').read_text(), self.original)

    def test_foreign_wrapper_is_preserved_and_crontab_not_changed(self):
        wrapper = self.home/'.local/bin/wbb-test'
        wrapper.parent.mkdir(parents=True)
        wrapper.write_text('foreign work')
        result = self.install()
        self.assertEqual(result.returncode, 1)
        self.assertEqual(wrapper.read_text(), 'foreign work')
        self.assertEqual(self.table.read_text(), self.original)

    def test_incomplete_managed_block_refuses_without_changing_crontab(self):
        malformed = self.original + '# BEGIN wbb-resource-monitor\n'
        self.table.write_text(malformed)
        result = self.install()
        self.assertEqual(result.returncode, 1)
        self.assertEqual(self.table.read_text(), malformed)


if __name__ == '__main__':
    unittest.main()
