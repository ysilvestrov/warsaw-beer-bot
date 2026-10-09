import contextlib
import hashlib
import io
import json
import os
import stat
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import dbsnap  # noqa: E402
from safe_tar import Refused  # noqa: E402

# A writer that dies without closing: its WAL (and SHM) stay on disk, as after a killed bot.
WRITER = '''
import os, sqlite3, sys
db = sqlite3.connect(sys.argv[1], isolation_level=None)
db.execute("PRAGMA journal_mode=WAL")
db.execute("PRAGMA wal_autocheckpoint=0")
db.execute("CREATE TABLE IF NOT EXISTS beer (name TEXT)")
for name in sys.argv[2:]:
    db.execute("INSERT INTO beer VALUES (?)", (name,))
os._exit(0)
'''


def read(path):
    with open(path, 'rb') as f:
        return f.read()


def write(path, data):
    with open(path, 'wb') as f:
        f.write(data)


class Tmp(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = self._tmp.name
        self.db = os.path.join(self.dir, 'bot.db')
        self.out = os.path.join(self.dir, 'x-post')
        self.pre = os.path.join(self.dir, 'x-pre.db')

    def tearDown(self):
        self._tmp.cleanup()

    def crashed_writer(self, *names):
        subprocess.run([sys.executable, '-I', '-c', WRITER, self.db, *names], check=True)

    def snapshot(self):
        """What `db-snapshot.sh snapshot` leaves: VACUUM INTO from a read-only connection + `<64 hex>\\n`."""
        src = sqlite3.connect(f'file:{self.db}?mode=ro', uri=True)
        src.execute('VACUUM INTO ?', (self.pre,))
        src.close()
        write(self.pre + '.sha256', (hashlib.sha256(read(self.pre)).hexdigest() + '\n').encode())

    def rows(self):
        db = sqlite3.connect(self.db)
        try:
            return [r[0] for r in db.execute('SELECT name FROM beer ORDER BY rowid')]
        finally:
            db.close()

    def fsynced(self, fn, *args):
        """(fn's result, inode numbers of everything fsynced while it ran)."""
        seen, real = [], os.fsync

        def spy(fd):
            seen.append(os.fstat(fd).st_ino)
            return real(fd)
        with mock.patch.object(os, 'fsync', spy):
            return fn(*args), seen

    def files(self, directory):
        return {n: read(os.path.join(directory, n)) for n in sorted(os.listdir(directory))}

    def stamps(self, directory):
        return {n: (st.st_ino, st.st_mtime_ns) for n in sorted(os.listdir(directory))
                for st in [os.stat(os.path.join(directory, n))]}

    def refused(self, fn, *args):
        with self.assertRaises(Refused) as cm:
            fn(*args)
        return str(cm.exception)


class Post(Tmp):
    def test_captures_db_wal_and_shm_with_their_checksums(self):
        self.crashed_writer('a', 'b')
        before = self.files(self.dir)
        manifest = dbsnap.post(self.db, self.out)
        self.assertEqual(sorted(before), ['bot.db', 'bot.db-shm', 'bot.db-wal'])
        self.assertEqual(manifest, {'files': {n: {'size': len(b), 'sha256': hashlib.sha256(b).hexdigest()}
                                              for n, b in before.items()}})
        self.assertEqual(self.files(self.out), {**before, 'post.json': json.dumps(
            manifest, sort_keys=True, separators=(',', ':')).encode()})
        self.assertEqual(sorted(os.listdir(self.dir)), ['bot.db', 'bot.db-shm', 'bot.db-wal', 'x-post'])

    def test_a_database_without_wal(self):
        write(self.db, b'plain')
        self.assertEqual(dbsnap.post(self.db, self.out),
                         {'files': {'bot.db': {'size': 5, 'sha256': hashlib.sha256(b'plain').hexdigest()}}})
        self.assertEqual(sorted(os.listdir(self.out)), ['bot.db', 'post.json'])

    def test_repeat_after_a_complete_post_rewrites_nothing(self):
        self.crashed_writer('a')
        first = dbsnap.post(self.db, self.out)
        stamps, content = self.stamps(self.out), self.files(self.out)
        self.crashed_writer('b')  # the live db moves on; the post must not follow it
        self.assertEqual(dbsnap.post(self.db, self.out), first)
        self.assertEqual((self.stamps(self.out), self.files(self.out)), (stamps, content))

    def test_a_repeat_makes_the_rename_durable(self):
        # 2v review: the attempt that renamed may have died before its fsync of the parent.
        self.crashed_writer('a')
        first = dbsnap.post(self.db, self.out)
        self.assertEqual(self.fsynced(dbsnap.post, self.db, self.out), (first, [os.stat(self.dir).st_ino]))

    def test_a_partial_left_by_a_crash_is_thrown_away(self):
        os.makedirs(self.out + '.partial/nested')
        write(self.out + '.partial/bot.db', b'junk')
        write(self.out + '.partial/post.json', b'{"files":{}}')
        write(self.db, b'live')
        dbsnap.post(self.db, self.out)
        self.assertEqual((os.path.lexists(self.out + '.partial'), sorted(os.listdir(self.out)),
                          read(os.path.join(self.out, 'bot.db'))), (False, ['bot.db', 'post.json'], b'live'))

    def test_crash_before_the_rename_leaves_no_post_and_the_retry_completes(self):
        write(self.db, b'live')
        with mock.patch.object(dbsnap.os, 'rename', side_effect=OSError(5, 'Input/output error')):
            with self.assertRaises(OSError):
                dbsnap.post(self.db, self.out)
        self.assertEqual((os.path.lexists(self.out), sorted(os.listdir(self.out + '.partial'))),
                         (False, ['bot.db', 'post.json']))
        dbsnap.post(self.db, self.out)
        self.assertEqual((os.path.lexists(self.out + '.partial'), read(os.path.join(self.out, 'bot.db'))),
                         (False, b'live'))

    def test_an_out_dir_without_post_json_is_refused_and_kept(self):
        write(self.db, b'live')
        os.mkdir(self.out)
        write(os.path.join(self.out, 'bot.db'), b'half')
        self.assertEqual(self.refused(dbsnap.post, self.db, self.out),
                         f'{self.out}: no post.json — not a complete post')
        self.assertEqual(self.files(self.out), {'bot.db': b'half'})

    def test_a_post_whose_file_changed_is_refused(self):
        self.crashed_writer('a')
        manifest = dbsnap.post(self.db, self.out)
        write(os.path.join(self.out, 'bot.db-wal'), b'x')
        want = manifest['files']['bot.db-wal']
        self.assertEqual(self.refused(dbsnap.post, self.db, self.out),
                         f'{self.out}/bot.db-wal: 1 bytes sha256 {hashlib.sha256(b"x").hexdigest()}, post.json says '
                         f'{want["size"]} bytes sha256 {want["sha256"]}')

    def test_a_post_with_an_extra_file_is_refused(self):
        write(self.db, b'live')
        dbsnap.post(self.db, self.out)
        write(os.path.join(self.out, 'extra'), b'')
        self.assertEqual(self.refused(dbsnap.post, self.db, self.out),
                         f"{self.out}: holds ['bot.db', 'extra', 'post.json'], its post.json names ['bot.db']")

    def test_a_post_json_of_another_database_is_refused(self):
        write(self.db, b'live')
        dbsnap.post(self.db, self.out)
        other = os.path.join(self.dir, 'other.db')
        self.assertEqual(self.refused(dbsnap.post, other, self.out),
                         f'{self.out}/post.json: not a post manifest of other.db')

    def test_a_malformed_post_json_is_refused(self):
        write(self.db, b'live')
        dbsnap.post(self.db, self.out)
        cases = [b'not json', b'{"files":{"bot.db":{"size":-1,"sha256":"' + b'0' * 64 + b'"}}}',
                 b'{"files":{"bot.db":{"size":4,"sha256":"' + b'G' * 64 + b'"}}}',
                 b'{"files":{"bot.db":{"size":true,"sha256":"' + b'0' * 64 + b'"}}}',
                 b'{"files":{},"extra":1}', b'[]']
        got = []
        for data in cases:
            write(os.path.join(self.out, 'post.json'), data)
            got.append(self.refused(dbsnap.post, self.db, self.out))
        self.assertEqual(got, [f'{self.out}/post.json: not a post manifest of bot.db'] * len(cases))

    def test_no_database_creates_nothing(self):
        self.assertEqual(self.refused(dbsnap.post, self.db, self.out), f'no database at {self.db}')
        self.assertEqual(os.listdir(self.dir), [])


class Restore(Tmp):
    def scenario(self):
        """pre holds a, b; afterwards c, d are written and a crashed writer leaves them in the WAL; post taken."""
        self.crashed_writer('a', 'b')
        self.snapshot()
        self.crashed_writer('c', 'd')
        self.assertEqual(sorted(os.listdir(self.dir)),
                         ['bot.db', 'bot.db-shm', 'bot.db-wal', 'x-pre.db', 'x-pre.db.sha256'])
        dbsnap.post(self.db, self.out)
        return {n: read(os.path.join(self.dir, n)) for n in ('bot.db', 'bot.db-shm', 'bot.db-wal')}

    def test_stale_wal_of_the_post_state_never_reaches_the_restored_db(self):
        self.scenario()
        self.assertEqual(dbsnap.restore(self.pre, self.db, self.out), 'restored')
        self.assertEqual((sorted(os.listdir(self.dir)), read(self.db)),
                         (['bot.db', 'x-post', 'x-pre.db', 'x-pre.db.sha256'], read(self.pre)))
        self.assertEqual(self.rows(), ['a', 'b'])

    def test_the_post_still_holds_the_lost_writes(self):
        self.scenario()
        dbsnap.restore(self.pre, self.db, self.out)
        self.db = os.path.join(self.out, 'bot.db')
        self.assertEqual(self.rows(), ['a', 'b', 'c', 'd'])

    def test_without_a_post_nothing_changes(self):
        self.crashed_writer('a')
        self.snapshot()
        before = self.files(self.dir)
        self.assertEqual(self.refused(dbsnap.restore, self.pre, self.db, self.out),
                         f'{self.out}: no post.json — not a complete post')
        self.assertEqual(self.files(self.dir), before)

    def test_a_corrupt_pre_is_refused_and_the_db_is_whole(self):
        live = self.scenario()
        want = read(self.pre + '.sha256').decode().strip()
        write(self.pre, read(self.pre)[:-1] + b'\x01')
        got = hashlib.sha256(read(self.pre)).hexdigest()
        self.assertEqual(self.refused(dbsnap.restore, self.pre, self.db, self.out),
                         f'checksum mismatch for {self.pre}: want {want}, got {got}')
        self.assertEqual({n: read(os.path.join(self.dir, n)) for n in live}, live)

    def test_a_pre_without_its_checksum_is_refused(self):
        self.scenario()
        os.unlink(self.pre + '.sha256')
        self.assertEqual(self.refused(dbsnap.restore, self.pre, self.db, self.out), f'no checksum for {self.pre}')
        self.assertEqual(os.path.exists(self.db + '-wal'), True)

    def test_a_checksum_file_that_is_not_one_sha256_line_is_refused(self):
        self.scenario()
        digest = read(self.pre + '.sha256').decode().strip()
        cases = [f'{digest}  x-pre.db\n', f'{digest}\n\n', digest.upper() + '\n', '']
        got = []
        for text in cases:
            write(self.pre + '.sha256', text.encode())
            got.append(self.refused(dbsnap.restore, self.pre, self.db, self.out))
        self.assertEqual(got, [f'{self.pre}.sha256: not a single sha256 line'] * len(cases))

    def test_a_pre_that_is_a_symlink_is_refused(self):
        self.scenario()
        os.rename(self.pre, self.pre + '.real')
        os.symlink(self.pre + '.real', self.pre)
        self.assertEqual(self.refused(dbsnap.restore, self.pre, self.db, self.out), f'{self.pre}: is a symlink')

    def test_a_repeat_after_a_restore_is_a_no_op(self):
        self.scenario()
        dbsnap.restore(self.pre, self.db, self.out)
        stamp = self.stamps(self.dir)['bot.db']
        self.assertEqual(dbsnap.restore(self.pre, self.db, self.out), 'already')
        self.assertEqual(self.stamps(self.dir)['bot.db'], stamp)

    def test_a_repeat_makes_the_replace_durable(self):
        # 2v review: the attempt that replaced the db may have died before its fsync of the directory.
        self.scenario()
        dbsnap.restore(self.pre, self.db, self.out)
        self.assertEqual(self.fsynced(dbsnap.restore, self.pre, self.db, self.out), ('already', [os.stat(self.dir).st_ino]))

    def test_a_db_equal_to_pre_but_with_a_wal_is_still_restored(self):
        self.scenario()
        write(self.db, read(self.pre))
        self.assertEqual(dbsnap.restore(self.pre, self.db, self.out), 'restored')
        self.assertEqual((os.path.exists(self.db + '-wal'), os.path.exists(self.db + '-shm')), (False, False))

    def test_crash_between_dropping_the_wal_and_the_rename_then_the_retry_finishes(self):
        live = self.scenario()
        with mock.patch.object(dbsnap.os, 'replace', side_effect=OSError(5, 'Input/output error')):
            with self.assertRaises(OSError):
                dbsnap.restore(self.pre, self.db, self.out)
        # The stale WAL is already gone; the db is still the post-state file, untouched.
        self.assertEqual((sorted(os.listdir(self.dir)), read(self.db)),
                         (['bot.db', 'bot.db.restore-partial', 'x-post', 'x-pre.db', 'x-pre.db.sha256'],
                          live['bot.db']))
        self.assertEqual(dbsnap.restore(self.pre, self.db, self.out), 'restored')
        self.assertEqual(sorted(os.listdir(self.dir)), ['bot.db', 'x-post', 'x-pre.db', 'x-pre.db.sha256'])
        self.assertEqual(self.rows(), ['a', 'b'])

    def test_a_copy_of_pre_that_fails_leaves_the_db_and_its_wal(self):
        # 2v review: the WAL was dropped before the copy existed; a full disk then left the db without it.
        live = self.scenario()
        with mock.patch.object(dbsnap, '_copy', side_effect=OSError(28, 'No space left on device')):
            with self.assertRaises(OSError):
                dbsnap.restore(self.pre, self.db, self.out)
        self.assertEqual({n: read(os.path.join(self.dir, n)) for n in sorted(os.listdir(self.dir)) if n in live}, live)

    def test_a_missing_db_is_restored(self):
        self.scenario()
        for n in ('bot.db', 'bot.db-wal', 'bot.db-shm'):
            os.unlink(os.path.join(self.dir, n))
        self.assertEqual(dbsnap.restore(self.pre, self.db, self.out), 'restored')
        self.assertEqual(self.rows(), ['a', 'b'])


    def test_the_live_database_keeps_its_exact_mode_under_a_tight_umask(self):
        # #823 AI review: the copy was created with the saved mode filtered by the umask, so a 0660
        # database (group access for another service) came back 0600 after a rollback.
        self.scenario()
        os.chmod(self.db, 0o660)
        old = os.umask(0o077)
        try:
            self.assertEqual(dbsnap.restore(self.pre, self.db, self.out), 'restored')
        finally:
            os.umask(old)
        self.assertEqual(stat.S_IMODE(os.stat(self.db).st_mode), 0o660)

class Cli(Tmp):
    def run_cli(self, argv):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = dbsnap.main(argv)
        return code, out.getvalue(), err.getvalue()

    def test_post_then_restore_then_again(self):
        self.crashed_writer('a')
        self.snapshot()
        self.crashed_writer('b')
        got = [self.run_cli(['post', self.db, self.out]), self.run_cli(['restore', self.pre, self.db, self.out]),
               self.run_cli(['restore', self.pre, self.db, self.out])]
        self.assertEqual(got, [(0, f'POST {self.out}\n', ''), (0, f'RESTORED {self.db}\n', ''),
                               (0, f'ALREADY {self.db}\n', '')])

    def test_refused_is_2(self):
        self.assertEqual(self.run_cli(['post', self.db, self.out]), (2, '', f'REFUSED: no database at {self.db}\n'))

    def test_an_os_error_is_75(self):
        write(self.db, b'live')
        out = os.path.join(self.dir, 'missing', 'x-post')
        code, stdout, err = self.run_cli(['post', self.db, out])
        self.assertEqual((code, stdout, err), (75, '', f"TRANSIENT: [Errno 2] No such file or directory: '{out}.partial'\n"))

    def test_internal_error_is_70(self):
        with mock.patch.object(dbsnap, 'post', side_effect=RuntimeError('bug')):
            code, out, err = self.run_cli(['post', self.db, self.out])
        self.assertEqual((code, out, err.splitlines()[-1]), (70, '', 'RuntimeError: bug'))

    def test_usage_is_64(self):
        got = [self.run_cli(argv)[0] for argv in ([], ['post', self.db], ['restore', self.pre, self.db],
                                                  ['snapshot', self.db, self.out], ['post', self.db, self.out, 'x'])]
        self.assertEqual(got, [64] * 5)


if __name__ == '__main__':
    unittest.main()
