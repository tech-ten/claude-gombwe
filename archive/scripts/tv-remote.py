#!/usr/bin/env python3
"""
tv-remote — drive an Android / Google TV via the official Remote v2 protocol.

Same protocol the Google TV phone app uses. After a one-time pairing (where
the TV displays a 6-digit code on screen), this can send any remote key
remotely from gombwe. No physical remote required.

Cert + key are stored at ~/.claude-gombwe/data/tv-remote/ (mode 0600). Pair
once, control forever.

Commands:
  pair-init <ip>            Start pairing — TV displays a 6-digit code
  pair-finish <code>        Complete pairing with the displayed code
  status                    Show connection state
  key <name|code>           Send a remote key (HOME, BACK, OK, UP, DOWN,
                            LEFT, RIGHT, MENU, POWER, VOLUME_UP, etc.)
  keys <names...>           Send several keys, 0.6s apart
  text <string>             Type a string (for input fields)
  reset                     Forget the pairing (delete cert + key)
"""

import asyncio
import json
import os
import sys
from pathlib import Path

DATA_DIR = Path.home() / ".claude-gombwe" / "data" / "tv-remote"
CONFIG_FILE = DATA_DIR / "config.json"
CERT_FILE = DATA_DIR / "cert.pem"
KEY_FILE = DATA_DIR / "key.pem"


def load_cfg():
    if not CONFIG_FILE.exists():
        return {}
    try:
        return json.loads(CONFIG_FILE.read_text())
    except Exception:
        return {}


def save_cfg(cfg):
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    CONFIG_FILE.write_text(json.dumps(cfg, indent=2))
    os.chmod(CONFIG_FILE, 0o600)


def secure_existing():
    for p in (CERT_FILE, KEY_FILE):
        if p.exists():
            os.chmod(p, 0o600)


async def make_remote(ip):
    from androidtvremote2 import AndroidTVRemote
    remote = AndroidTVRemote(
        client_name="gombwe",
        certfile=str(CERT_FILE),
        keyfile=str(KEY_FILE),
        host=ip,
    )
    await remote.async_generate_cert_if_missing()
    secure_existing()
    return remote


async def cmd_pair_init(ip):
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    remote = await make_remote(ip)
    name, mac = await remote.async_get_name_and_mac()
    print(f"TV: {name} ({mac})")
    await remote.async_start_pairing()
    save_cfg({"ip": ip, "name": name, "mac": mac, "pairing": "in-progress"})
    print(f"Pairing started. The TV should be showing a 6-digit code on screen.")
    print(f"Run:  tv-remote pair-finish <code>")
    # Keep the SSL session alive long enough — the lib expects pair-finish on the same connection
    # so we save the remote object's state via cert files. The official flow needs the same instance.
    # Workaround: we fall through to wait-for-input on stdin.
    code = sys.stdin.readline().strip()
    if not code:
        print("(no code entered on stdin — call pair-finish in a separate run)")
        return
    try:
        await remote.async_finish_pairing(code)
        save_cfg({"ip": ip, "name": name, "mac": mac, "pairing": "done"})
        print("✓ Paired successfully.")
    except Exception as e:
        print(f"✗ Pairing failed: {e}")


async def cmd_pair(ip, code):
    """Single-shot pair: start + finish in one async session (the lib needs same instance)."""
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    remote = await make_remote(ip)
    name, mac = await remote.async_get_name_and_mac()
    print(f"TV: {name} ({mac})")
    await remote.async_start_pairing()
    print("(TV should be showing a 6-digit code — entering it now)")
    await remote.async_finish_pairing(code)
    save_cfg({"ip": ip, "name": name, "mac": mac, "pairing": "done"})
    secure_existing()
    print("✓ Paired successfully.")


async def cmd_pair_interactive(ip):
    """Long-running pairing. Starts pairing (TV shows code), then reads the
    code from stdin and finishes pairing in the SAME SSL session — which is
    what the TV requires."""
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    remote = await make_remote(ip)
    name, mac = await remote.async_get_name_and_mac()
    print(f"TV: {name} ({mac})", flush=True)
    await remote.async_start_pairing()
    print("READY — TV should be showing a 6-digit code on screen.", flush=True)
    print("(waiting for code on stdin — pipe via the fifo)", flush=True)
    # Read code from stdin (blocks until input arrives)
    loop = asyncio.get_event_loop()
    line = await loop.run_in_executor(None, sys.stdin.readline)
    code = (line or "").strip()
    if not code:
        print("no code provided", flush=True)
        return
    print(f"submitting code: {code}", flush=True)
    try:
        await remote.async_finish_pairing(code)
        save_cfg({"ip": ip, "name": name, "mac": mac, "pairing": "done"})
        secure_existing()
        print("PAIRED", flush=True)
    except Exception as e:
        print(f"PAIRING_FAILED: {e}", flush=True)


async def cmd_status():
    cfg = load_cfg()
    print(json.dumps(cfg, indent=2))
    print(f"cert exists: {CERT_FILE.exists()}")
    print(f"key  exists: {KEY_FILE.exists()}")


async def with_connected(fn):
    cfg = load_cfg()
    if not cfg.get("ip"):
        print("Not paired. Run: tv-remote pair-init <ip>")
        sys.exit(2)
    if not CERT_FILE.exists() or not KEY_FILE.exists():
        print("Pairing certificate missing. Run: tv-remote pair-init <ip> again.")
        sys.exit(2)
    remote = await make_remote(cfg["ip"])
    try:
        await remote.async_connect()
    except Exception as e:
        print(f"connect failed: {e}")
        sys.exit(3)
    try:
        await fn(remote)
    finally:
        try:
            remote.disconnect()
        except Exception:
            pass


def _resolve_key(name):
    n = name.lower()
    if n in KEY_NAMES: return KEY_NAMES[n]
    up = name.upper()
    if up in ('UP', 'DOWN', 'LEFT', 'RIGHT'): return f'KEYCODE_DPAD_{up}'
    if not up.startswith('KEYCODE_'): return f'KEYCODE_{up}'
    return up


async def cmd_key(name):
    async def go(remote):
        code = _resolve_key(name)
        remote.send_key_command(code)
        print(f"sent {code}")
        await asyncio.sleep(0.2)
    await with_connected(go)


async def cmd_keys(names):
    async def go(remote):
        for n in names:
            code = _resolve_key(n)
            remote.send_key_command(code)
            print(f"sent {code}")
            await asyncio.sleep(0.6)
    await with_connected(go)


async def cmd_text(s):
    async def go(remote):
        remote.send_text(s)
        print(f"sent text: {s!r}")
        await asyncio.sleep(0.2)
    await with_connected(go)


async def cmd_launch(url):
    async def go(remote):
        remote.send_launch_app_command(url)
        print(f"launched: {url}")
        await asyncio.sleep(0.5)
    await with_connected(go)


def cmd_reset():
    for p in (CERT_FILE, KEY_FILE, CONFIG_FILE):
        if p.exists():
            p.unlink()
    print("Pairing reset.")


def main():
    argv = sys.argv[1:]
    if not argv:
        print(__doc__)
        sys.exit(0)
    cmd = argv[0]
    try:
        if cmd == "pair-init":
            asyncio.run(cmd_pair_interactive(argv[1]))
        elif cmd == "pair-interactive":
            asyncio.run(cmd_pair_interactive(argv[1]))
        elif cmd == "pair":
            asyncio.run(cmd_pair(argv[1], argv[2]))
        elif cmd == "status":
            asyncio.run(cmd_status())
        elif cmd == "key":
            asyncio.run(cmd_key(argv[1]))
        elif cmd == "keys":
            asyncio.run(cmd_keys(argv[1:]))
        elif cmd == "text":
            asyncio.run(cmd_text(argv[1]))
        elif cmd == "launch":
            asyncio.run(cmd_launch(argv[1]))
        elif cmd == "reset":
            cmd_reset()
        else:
            print(f"unknown command: {cmd}")
            print(__doc__)
            sys.exit(2)
    except KeyboardInterrupt:
        sys.exit(130)


if __name__ == "__main__":
    main()
