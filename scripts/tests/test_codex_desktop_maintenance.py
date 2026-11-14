"""Exercise destructive maintenance paths only inside a disposable Webtop container."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / "iac/workloads/selfhosted/codex-desktop/scripts"


MOCK_COMMAND = r'''#!/usr/bin/env python3
import json, os, pathlib, subprocess, sys
name = pathlib.Path(sys.argv[0]).name
state = pathlib.Path(os.environ["TEST_STATE"])
with (state / "calls").open("a") as log:
    log.write(json.dumps([name, *sys.argv[1:]]) + "\n")
if name == "dpkg-query":
    print((state / "version").read_text(), end="")
elif name == "apt-get":
    if "update" in sys.argv:
        source_option = next(x for x in sys.argv if x.startswith("Dir::Etc::sourceparts="))
        sources = pathlib.Path(source_option.split("=", 1)[1])
        assert sorted(x.name for x in sources.iterdir()) == ["chatgpt.sources", "ubuntu.sources"]
        assert "Signed-By:" in (sources / "chatgpt.sources").read_text()
        assert pathlib.Path("/run/codex-desktop-upgrading").exists()
        if os.environ.get("FAIL_UPDATE"):
            sys.exit(100)
    elif "upgrade" in sys.argv:
        (state / "version").write_text(os.environ["NEW_VERSION"])
        if os.environ.get("FAIL_UPGRADE"):
            sys.exit(100)
elif name == "pkill":
    sys.exit(int(os.environ.get("PKILL_STATUS", "0")))
elif name == "date":
    if sys.argv[1:] == ["+%s"]:
        print(os.environ["TEST_NOW"])
    elif sys.argv[1:3] == ["-d", "today 04:00"]:
        subprocess.run(["/usr/bin/date", "-d", os.environ["TEST_TODAY"] + " 04:00", "+%s"], check=True)
    elif sys.argv[1:3] == ["-d", "tomorrow 04:00"]:
        subprocess.run(["/usr/bin/date", "-d", os.environ["TEST_TOMORROW"] + " 04:00", "+%s"], check=True)
    else:
        subprocess.run(["/usr/bin/date", *sys.argv[1:]], check=True)
elif name == "sleep":
    marker = state / "slept"
    if marker.exists():
        sys.exit(1)
    marker.touch()
'''


class MaintenanceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.state = Path(self.temp.name)
        self.bin = self.state / "bin"
        self.bin.mkdir()
        for name in ("dpkg-query", "apt-get", "pkill", "date", "sleep"):
            command = self.bin / name
            command.write_text(MOCK_COMMAND)
            command.chmod(0o755)
        (self.state / "version").write_text("1.0")
        self.env = dict(os.environ, PATH=f"{self.bin}:{os.environ['PATH']}",
                        TEST_STATE=str(self.state), NEW_VERSION="2.0", TZ="Europe/Madrid")
        sources = Path("/etc/apt/sources.list.d")
        sources.mkdir(parents=True, exist_ok=True)
        (sources / "chatgpt.sources").write_text("Types: deb\nSigned-By: /usr/share/keyrings/chatgpt-archive-keyring.gpg\n")
        Path("/run/codex-desktop-installed").touch()
        Path("/run/codex-desktop-upgrading").unlink(missing_ok=True)
        Path("/config/.cache").mkdir(parents=True, exist_ok=True)
        Path("/config/.cache/codex-desktop-version").unlink(missing_ok=True)

    def calls(self, command):
        return [args[1:] for line in (self.state / "calls").read_text().splitlines()
                if (args := json.loads(line))[0] == command]

    def upgrade(self, success=True, **env):
        result = subprocess.run(["bash", str(SCRIPTS / "upgrade.sh")],
                                env={**self.env, **env}, capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode == 0, success, result.stdout + result.stderr)
        self.assertFalse(Path("/run/codex-desktop-upgrading").exists())
        self.assertFalse([p for p in Path("/run").glob("codex-desktop-apt.*") if p.is_dir()])
        return result

    def test_changed_package_restarts_only_codex_after_upgrade(self):
        self.upgrade()
        self.assertEqual(self.calls("pkill"), [["-TERM", "-u", "abc", "-x", "ChatGPT"]])
        upgrade = next(args for args in self.calls("apt-get") if "upgrade" in args)
        for option in ("--no-remove", "--with-new-pkgs", "Dpkg::Options::=--force-confold"):
            self.assertIn(option, upgrade)
        self.assertEqual(self.calls("apt-get")[-1], ["clean"])

    def test_unchanged_package_keeps_codex_running(self):
        self.upgrade(NEW_VERSION="1.0")
        self.assertEqual(self.calls("pkill"), [])

    def test_failed_refresh_does_not_upgrade_or_restart(self):
        self.upgrade(success=False, FAIL_UPDATE="1")
        self.assertFalse(any("upgrade" in args for args in self.calls("apt-get")))
        self.assertEqual(self.calls("pkill"), [])

    def test_partial_upgrade_failure_does_not_restart(self):
        Path("/config/.cache/codex-desktop-version").write_text("1.0")
        self.upgrade(success=False, FAIL_UPGRADE="1")
        self.assertEqual((self.state / "version").read_text(), "2.0")
        self.assertEqual(self.calls("pkill"), [])
        self.upgrade()
        self.assertEqual(len(self.calls("pkill")), 1)

    def test_startup_upgrades_without_killing_a_session(self):
        Path("/run/codex-desktop-installed").unlink()
        self.upgrade()
        self.assertTrue(any("upgrade" in args for args in self.calls("apt-get")))
        self.assertEqual(self.calls("pkill"), [])

    def test_absent_app_is_not_an_upgrade_failure(self):
        self.upgrade(PKILL_STATUS="1")

    def test_missing_vendor_source_fails_closed(self):
        Path("/etc/apt/sources.list.d/chatgpt.sources").unlink()
        self.upgrade(success=False)
        self.assertFalse((self.state / "calls").exists())

    def test_schedule_uses_local_four_am_and_waits_until_next_day_after_failure(self):
        for now, today, tomorrow, delay in (
            ("2026-11-14 03:00", "2026-11-14", "2026-11-15", 3600),
            ("2026-03-28 05:00", "2026-03-28", "2026-03-29", 22 * 3600),
            ("2026-10-24 05:00", "2026-10-24", "2026-10-25", 24 * 3600),
        ):
            with self.subTest(now=now):
                (self.state / "calls").unlink(missing_ok=True)
                (self.state / "slept").unlink(missing_ok=True)
                target = Path("/opt/codex-desktop/upgrade.sh")
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text('#!/bin/bash\necho attempt >> "$TEST_STATE/attempts"\nexit 100\n')
                target.chmod(0o755)
                (self.state / "attempts").unlink(missing_ok=True)
                epoch = subprocess.check_output(["/usr/bin/date", "-d", now, "+%s"], env=self.env, text=True).strip()
                result = subprocess.run(["bash", str(SCRIPTS / "maintenance.sh")],
                                        env={**self.env, "TEST_NOW": epoch, "TEST_TODAY": today,
                                             "TEST_TOMORROW": tomorrow},
                                        capture_output=True, text=True, timeout=15)
                self.assertEqual(self.calls("sleep"), [[str(delay)], [str(delay)]])
                self.assertEqual((self.state / "attempts").read_text(), "attempt\n")
                self.assertIn("retrying at the next daily window", result.stderr)


if __name__ == "__main__":
    if os.environ.get("CODEX_MAINTENANCE_TEST_CONTAINER") != "1":
        import re
        image = re.search(r'image: "([^"]+)"', (SCRIPTS.parent / "index.ts").read_text()).group(1)
        raise SystemExit(subprocess.call([
            "docker", "run", "--rm", "--entrypoint", "python3",
            "-e", "CODEX_MAINTENANCE_TEST_CONTAINER=1", "-v", f"{ROOT}:/repo:ro",
            image, "/repo/scripts/tests/test_codex_desktop_maintenance.py",
        ]))
    unittest.main(verbosity=2)
