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
                        WBB_RESOURCE_SUMMARY_DIR=str(self.root/'summary'),
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
        copies = list((self.home/'.local/lib/wbb-ops').glob('*/resource_monitor.py'))
        self.assertEqual(len(copies), 1)
        state = self.home/'.local/state/wbb-resource-monitor'
        self.assertEqual(table, self.original + '# BEGIN wbb-resource-monitor\n' +
                         f'*/5 * * * * /usr/bin/timeout 60s /usr/bin/nice -n 19 /usr/bin/ionice -c 3 '
                         f'/usr/bin/python3 -B {copies[0]} --state-dir {state} '
                         f'--runs-dir /tmp/wbb-test-runs-{os.getuid()} '
                         f'--summary-dir {self.root}/summary --notify telegram >/dev/null 2>&1\n'
                         '# END wbb-resource-monitor\n')
        self.assertEqual(copies[0].read_bytes(),
                         (INSTALLER.parents[1]/'scripts/ops/resource_monitor.py').read_bytes())
        wrapper = self.home/'.local/bin/wbb-test'
        self.assertEqual(wrapper.stat().st_mode & 0o777, 0o700)
        self.assertEqual(wrapper.read_text(), '#!/bin/sh\n'
                         '# Managed by warsaw-beer-bot resource monitor installer\n'
                         f'exec /usr/bin/python3 -B {copies[0].parent}/test_run.py '
                         '-- node ./node_modules/vitest/vitest.mjs run "$@"\n')
        self.assertEqual((state/'crontab.before-install').read_text(), self.original)
        self.assertEqual((self.root/'summary').stat().st_mode & 0o777, 0o755)
        self.assertEqual(state.stat().st_mode & 0o777, 0o700)

    def test_repeat_install_keeps_private_monitor_evidence(self):
        first = self.install()
        self.assertEqual(first.returncode, 0, first.stderr)
        state = self.home/'.local/state/wbb-resource-monitor/state.json'
        state.write_bytes(b'private monitor history and delivery acknowledgement')
        state.chmod(0o600)
        second = self.install()
        self.assertEqual(second.returncode, 0, second.stderr)
        self.assertEqual(state.read_bytes(), b'private monitor history and delivery acknowledgement')
        self.assertEqual(state.stat().st_mode & 0o777, 0o600)

    def test_symlink_export_directory_refuses_without_changing_cron(self):
        target = self.root/'target'
        target.mkdir(mode=0o755)
        (self.root/'summary').symlink_to(target, target_is_directory=True)
        result = self.install()
        self.assertEqual(result.returncode, 1)
        self.assertEqual(self.table.read_text(), self.original)
        self.assertEqual(list(target.iterdir()), [])

    def test_writable_export_directory_is_not_repaired_or_used(self):
        summary = self.root/'summary'
        summary.mkdir(mode=0o777)
        summary.chmod(0o777)
        result = self.install()
        self.assertEqual(result.returncode, 1)
        self.assertEqual(summary.stat().st_mode & 0o777, 0o777)
        self.assertEqual(self.table.read_text(), self.original)

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

    def test_unmanaged_monitor_is_preserved_and_refuses_duplicate(self):
        unrelated = self.original + '*/5 * * * * /usr/bin/python3 /existing/resource_monitor.py\n'
        self.table.write_text(unrelated)
        result = self.install()
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stderr, 'Install refused: an unmanaged resource monitor already exists; retained\n')
        self.assertEqual(self.table.read_text(), unrelated)

    def test_concurrent_crontab_edit_is_preserved(self):
        self.stub.write_text('''#!/usr/bin/env python3
import sys,os
from pathlib import Path
p=Path(os.environ['TEST_CRONTAB_FILE'])
counter=p.with_name('read-count')
if sys.argv[1]=='-l':
    count=int(counter.read_text())+1 if counter.exists() else 1
    counter.write_text(str(count))
    if count==2:p.write_text(p.read_text()+'# concurrent edit\\n')
    sys.stdout.write(p.read_text())
else:p.write_text(Path(sys.argv[1]).read_text())
''')
        result = self.install()
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stderr, 'Install refused: crontab changed during preparation; retry without overwriting it\n')
        self.assertEqual(self.table.read_text(), self.original + '# concurrent edit\n')


if __name__ == '__main__':
    unittest.main()
