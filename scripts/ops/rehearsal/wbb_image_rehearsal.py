#!/usr/bin/env python3
"""The checkout's root helper `wbb_image` under the rehearsal kit's names: unit `wbb-rehearsal`, never production's.

Plan: docs/superpowers/plans/2026-10/2026-10-22-wbb-image-transition-v-harness.md, "Рішення" п.1, п.4, Task 1.

Not installed. The kit's controller runs it as root through `sudo python3 -I` (the operator's own `sudo -v`
cache, no NOPASSWD rule): it imports deploy/image/helper/wbb_image.py from the same checkout and calls its
`main(argv, host=REHEARSAL)`, so argv, output and exit codes are the helper's own. For that call only, the
helper's module constants CONTAINER and UNIT name the rehearsal's container and unit (the helper reads both at
call time) and its `render_template` is wrapped:

  REHEARSAL_SICK_DIGEST=sha256:<64 hex>  the unit rendered for THIS digest runs `node -e "process.exit(1)"`
                                         instead of the bot: a candidate that starts and dies (scenario «в»).
                                         Any other digest renders the kit's template unchanged. Unset or
                                         empty: nothing is sick. Not a digest: REFUSED, exit 2, nothing run.

What the kit owns on the host: the Quadlet file below (systemd names the unit after it), the kit's template in
this directory, and KIT_ROOT — `data/` (the bot's copy of the production DB and its pre snapshots) and
`scratch/` (root, 0700: the trial copies). Podman, systemctl, the images' filesystem and the bot's user are
production's.
"""
import contextlib
import dataclasses
import os
import sys
import traceback

EX_SOFTWARE = 70

HERE = os.path.dirname(os.path.abspath(__file__))
HELPER_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(HERE))), 'deploy', 'image', 'helper')

# Root imports the helper from the operator's checkout: no root-owned __pycache__ left in it.
sys.dont_write_bytecode = True
sys.path.insert(0, HELPER_DIR)
try:
    import wbb_image  # noqa: E402
except Exception:
    # Python's own exit on an uncaught import error is 1, which from the helper means a bad candidate.
    if __name__ != '__main__':
        raise
    traceback.print_exc()
    sys.exit(EX_SOFTWARE)

CONTAINER = 'wbb-rehearsal'
UNIT = 'wbb-rehearsal.service'
KIT_ROOT = '/var/lib/wbb-rehearsal'
SICK_ENV = 'REHEARSAL_SICK_DIGEST'
SICK_EXEC = 'Exec=node -e "process.exit(1)"'

REHEARSAL = dataclasses.replace(
    wbb_image.PRODUCTION,
    quadlet_path=f'/etc/containers/systemd/{CONTAINER}.container',
    template_path=os.path.join(HERE, f'{CONTAINER}.container'),
    snapshot_root=f'{KIT_ROOT}/data/deploy-snapshots',
    scratch_root=f'{KIT_ROOT}/scratch',
)


def sick_render(render, sick):
    """`render` (the helper's render_template), with SICK_EXEC as the first line of [Container] for `sick`."""
    def rendered(lines, digest, uid, gid):
        text = render(lines, digest, uid, gid)
        if sick is None or digest != sick:
            return text
        out = text.splitlines(keepends=True)
        # No [Container] section is a broken kit template: ValueError, the helper's internal error (70).
        at = out.index('[Container]\n')
        out.insert(at + 1, SICK_EXEC + '\n')
        return ''.join(out)
    return rendered


@contextlib.contextmanager
def rehearsal_names(sick):
    """The helper's CONTAINER, UNIT and render_template as the kit's, put back on the way out."""
    saved = (wbb_image.CONTAINER, wbb_image.UNIT, wbb_image.render_template)
    wbb_image.CONTAINER, wbb_image.UNIT = CONTAINER, UNIT
    wbb_image.render_template = sick_render(saved[2], sick)
    try:
        yield
    finally:
        wbb_image.CONTAINER, wbb_image.UNIT, wbb_image.render_template = saved


def main(argv, host=REHEARSAL, environ=os.environ):
    sick = environ.get(SICK_ENV) or None
    if sick is not None and not wbb_image.DIGEST.fullmatch(sick):
        print(f'REFUSED: {SICK_ENV}={sick!r} is not a sha256:<64 lowercase hex> digest', file=sys.stderr)
        return wbb_image.EX_REFUSED
    with rehearsal_names(sick):
        return wbb_image.main(argv, host)


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
