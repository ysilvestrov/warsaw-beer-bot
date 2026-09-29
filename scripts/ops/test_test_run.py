"""Real subprocess regressions: deletion must follow kernel completion, not PID age."""
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest

SCRIPT = Path(__file__).with_name('test_run.py')


def wait_for(predicate):
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.02)
    raise AssertionError('controlled child did not reach its checkpoint')


def process_finished(pid):
    try:
        return Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()[0] == 'Z'
    except FileNotFoundError:
        return True


class TestRun(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory(prefix='supervisor-probe-')
        self.root = Path(self.scratch.name)
        self.base = self.root / 'runs'
        self.processes = []
        self.release = self.root / 'release'

    def tearDown(self):
        self.release.touch()
        for process in self.processes:
            try:
                process.communicate(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.communicate(timeout=5)
        self.scratch.cleanup()

    def launch(self, code):
        process = subprocess.Popen(
            [sys.executable, str(SCRIPT), '--base', str(self.base), '--',
             sys.executable, '-c', code], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
        self.processes.append(process)
        return process

    def inspect(self):
        result = subprocess.run(
            [sys.executable, str(SCRIPT), '--base', str(self.base), '--inspect'],
            capture_output=True, text=True, timeout=10,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def test_success_cleans_fixtures_and_propagates_all_temp_variables(self):
        out = self.root / 'observations.json'
        sentinel = self.root / 'sentinel'
        sentinel.write_text('keep')
        process = self.launch(f'''
import os,json,subprocess,sys
from pathlib import Path
p=Path(os.environ['TMPDIR'])
(p/'fixture').mkdir()
(p/'fixture'/'sentinel-link').symlink_to({str(sentinel)!r})
child=json.loads(subprocess.check_output([sys.executable,'-c',
    'import os,json;print(json.dumps([os.environ[k] for k in ("TMPDIR","TMP","TEMP")]))']))
Path({str(out)!r}).write_text(json.dumps({{'tmp':[os.environ[k] for k in ('TMPDIR','TMP','TEMP')],
    'child':child,'mode':p.stat().st_mode&0o777,'root_mode':p.parent.stat().st_mode&0o777}}))
''')
        _, stderr = process.communicate(timeout=10)
        self.assertEqual(process.returncode, 0, stderr.decode())
        values = json.loads(out.read_text())
        payload = str(Path(values['tmp'][0]))
        self.assertEqual(values, {'tmp': [payload]*3, 'child': [payload]*3,
                                  'mode': 0o700, 'root_mode': 0o700})
        self.assertEqual(list(self.base.iterdir()), [])
        self.assertEqual(sentinel.read_text(), 'keep')

    def test_failure_keeps_exact_exit_code_and_removes_root(self):
        process = self.launch("import os,sys;open(os.environ['TMPDIR']+'/failed','w').write('x');sys.exit(7)")
        _, stderr = process.communicate(timeout=10)
        self.assertEqual(process.returncode, 7, stderr.decode())
        self.assertEqual(list(self.base.iterdir()), [])

    def held_child(self, ready, release, exit_code=0):
        return f'''
import os,time,subprocess,sys,json
from pathlib import Path
code={f"import os,time,json;from pathlib import Path;p=Path(os.environ['TMPDIR']);(p/'alive').write_text('x');Path({str(ready)!r}).write_text(json.dumps({{'pid':os.getpid(),'tmp':str(p)}}));\nwhile not Path({str(release)!r}).exists(): time.sleep(.02)"!r}
subprocess.Popen([sys.executable,'-c',code],start_new_session=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
while not Path({str(ready)!r}).exists(): time.sleep(.02)
sys.exit({exit_code})
'''

    def test_waits_for_detached_descendant_after_main_exits(self):
        ready = self.root / 'ready'
        process = self.launch(self.held_child(ready, self.release, 7))
        wait_for(ready.exists)
        observed = json.loads(ready.read_text())
        self.assertEqual(process.poll(), None)
        self.assertEqual(Path(observed['tmp'], 'alive').read_text(), 'x')
        self.assertEqual(self.inspect()[0]['status'], 'active')
        self.release.touch()
        _, stderr = process.communicate(timeout=10)
        self.assertEqual(process.returncode, 7, stderr.decode())
        self.assertEqual(list(self.base.iterdir()), [])

    def test_parallel_runs_are_independent(self):
        ready1, ready2 = self.root / 'ready1', self.root / 'ready2'
        release1 = self.root / 'release1'
        first = self.launch(self.held_child(ready1, release1))
        second = self.launch(self.held_child(ready2, self.release))
        wait_for(lambda: ready1.exists() and ready2.exists())
        tmp1 = Path(json.loads(ready1.read_text())['tmp'])
        tmp2 = Path(json.loads(ready2.read_text())['tmp'])
        self.assertNotEqual(tmp1, tmp2)
        release1.touch()
        first.communicate(timeout=10)
        self.assertEqual(first.returncode, 0)
        self.assertEqual(tmp1.exists(), False)
        self.assertEqual(tmp2.joinpath('alive').read_text(), 'x')
        self.assertEqual(second.poll(), None)
        self.release.touch()
        second.communicate(timeout=10)
        self.assertEqual(second.returncode, 0)
        self.assertEqual(list(self.base.iterdir()), [])

    def test_sigint_and_sigterm_reap_before_removal(self):
        for signum, expected in [(signal.SIGINT, 130), (signal.SIGTERM, 143)]:
            with self.subTest(signum=signum):
                ready = self.root / f'ready-{signum}'
                process = self.launch(f"import time;from pathlib import Path;Path({str(ready)!r}).touch();time.sleep(60)")
                wait_for(ready.exists)
                process.send_signal(signum)
                process.communicate(timeout=10)
                self.assertEqual(process.returncode, expected)
                self.assertEqual(list(self.base.iterdir()), [])

    def test_sigkill_keeps_surviving_child_and_then_uncertain_root(self):
        ready = self.root / 'ready'
        process = self.launch(self.held_child(ready, self.release))
        wait_for(ready.exists)
        observed = json.loads(ready.read_text())
        process.kill()
        process.communicate(timeout=10)
        self.assertEqual(process.returncode, -signal.SIGKILL)
        self.assertEqual(Path(observed['tmp'], 'alive').read_text(), 'x')
        self.assertEqual(self.inspect()[0]['status'], 'observed_processes')
        self.release.touch()
        wait_for(lambda: process_finished(observed['pid']))
        self.assertEqual(self.inspect()[0]['status'], 'uncertain_current_boot')
        self.assertEqual(Path(observed['tmp']).exists(), True)

    def test_pid_reuse_does_not_turn_an_unlocked_root_active(self):
        ready = self.root / 'ready'
        process = self.launch(self.held_child(ready, self.release))
        wait_for(ready.exists)
        process.kill()
        process.communicate(timeout=10)
        self.release.touch()
        child_pid = json.loads(ready.read_text())['pid']
        wait_for(lambda: process_finished(child_pid))
        manifest = next(self.base.glob('run-*/run.json'))
        metadata = json.loads(manifest.read_text())
        metadata['supervisor_pid'] = os.getpid()
        metadata['supervisor_start'] = 1
        manifest.write_text(json.dumps(metadata))
        self.assertEqual(self.inspect()[0]['status'], 'uncertain_current_boot')
        self.assertEqual(manifest.exists(), True)

    def test_previous_boot_is_reported_but_never_deleted(self):
        process = self.launch('pass')
        process.communicate(timeout=10)
        # A real interrupted run supplies metadata; change only its recorded boot.
        ready = self.root / 'ready'
        process = self.launch(self.held_child(ready, self.release))
        wait_for(ready.exists)
        process.kill()
        process.communicate(timeout=10)
        self.release.touch()
        child_pid = json.loads(ready.read_text())['pid']
        wait_for(lambda: process_finished(child_pid))
        manifest = next(self.base.glob('run-*/run.json'))
        metadata = json.loads(manifest.read_text())
        metadata['boot_id'] = 'previous-boot'
        manifest.write_text(json.dumps(metadata))
        self.assertEqual(self.inspect()[0]['status'], 'previous_boot_retained')
        self.assertEqual(manifest.exists(), True)

    def test_refuses_symlink_base_without_touching_target(self):
        target = self.root / 'target'
        target.mkdir(mode=0o700)
        self.base.symlink_to(target, target_is_directory=True)
        process = self.launch('pass')
        _, stderr = process.communicate(timeout=10)
        self.assertEqual(process.returncode, 125, stderr.decode())
        self.assertEqual(list(target.iterdir()), [])

    def test_changed_root_is_retained(self):
        process = self.launch('''
import os
from pathlib import Path
root=Path(os.environ['TMPDIR']).parent
root.rename(root.with_name(root.name+'-moved'))
root.mkdir(mode=0o700)
(root/'keep').write_text('keep')
''')
        _, stderr = process.communicate(timeout=10)
        self.assertEqual(process.returncode, 125, stderr.decode())
        self.assertEqual(next(self.base.glob('run-*/keep')).read_text(), 'keep')

    def test_ordinary_npm_success_and_failure_remove_real_vitest_cache(self):
        repo = SCRIPT.parents[2]
        for expected in (0, 1):
            with self.subTest(expected=expected):
                out = self.root / f'cache-{expected}.json'
                fallback = self.root / f'fallback-{expected}'
                fallback.mkdir(mode=0o700)
                fixture = self.root / 'typed-fixture.ts'
                fixture.write_text("export const isolatedCacheProbe: string = 'wbb-probe-cache-value-19';")
                test = self.root / 'probe.test.mjs'
                test.write_text(f'''
import {{it,expect}} from {str(repo.joinpath('node_modules/vitest/dist/index.js').as_uri())!r};
import {{isolatedCacheProbe}} from './typed-fixture.ts';
import {{tmpdir}} from 'node:os';
import {{readdirSync,readFileSync,writeFileSync,mkdirSync,statSync}} from 'node:fs';
import {{join}} from 'node:path';
it('records real transformations',()=>{{
  expect(isolatedCacheProbe).toBe(['wbb-probe','cache-value','19'].join('-'));
  mkdirSync(join(tmpdir(),'intentionally-unregistered-fixture'));
  const marker=['wbb-probe','cache-value','19'].join('-');
  const matched = readdirSync(tmpdir(),{{recursive:true}}).map(name=>join(tmpdir(),name))
    .filter(path=>statSync(path).isFile() && /[0-9a-f]{{40}}$/.test(path))
    .filter(path=>readFileSync(path,'utf8').includes(marker));
  writeFileSync({str(out)!r}, JSON.stringify({{tmp:tmpdir(), matched,
    fixture:join(tmpdir(),'intentionally-unregistered-fixture'), nodeCache:process.env.NODE_COMPILE_CACHE}}));
  expect(1).toBe({1 if expected == 0 else 2});
}});
''')
                config = self.root / 'vitest.config.mjs'
                config.write_text(f"import config from {str(repo.joinpath('vitest.config.ts'))!r}; "
                                  f"export default {{...config,test:{{...config.test,include:[{str(test)!r}]}}}};")
                env = dict(os.environ, TMPDIR=str(fallback), TMP=str(fallback), TEMP=str(fallback),
                           WBB_TEST_RUNS_DIR=str(self.base), NODE_COMPILE_CACHE=str(self.root/'npm-parent-cache'))
                result = subprocess.run(['npm', 'test', '--', '--config', str(config)],
                                        cwd=repo, env=env, capture_output=True, timeout=30)
                self.assertEqual(result.returncode, expected, result.stderr.decode())
                values = json.loads(out.read_text())
                payload = Path(values['tmp'])
                self.assertEqual(payload.parent.parent, self.base)
                self.assertEqual(values['nodeCache'], str(payload/'node-compile-cache'))
                self.assertEqual(len(values['matched']), 1, values)
                self.assertEqual([Path(p).is_relative_to(payload) for p in values['matched']], [True])
                self.assertEqual(Path(values['fixture']).exists(), False)
                self.assertEqual(payload.parent.exists(), False)
                self.assertEqual(list(self.base.iterdir()), [])
                self.assertEqual(list(fallback.iterdir()), [])


if __name__ == '__main__':
    unittest.main()
