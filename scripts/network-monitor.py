#!/usr/bin/env python3
"""
network-monitor — periodic snapshot of MikroTik state for per-device activity tracking.

Polls every POLL_INTERVAL seconds:
  - /ip/dhcp-server/lease  (device name + IP + MAC)
  - /ip/arp                (IP → MAC fallback for devices without leases)
  - /ip/firewall/connection (active TCP/UDP flows: src/dst/bytes)

Writes one JSONL line per poll to ~/.claude-gombwe/data/network/YYYY-MM-DD.jsonl
Each line: {ts, devices: [...], connections: [...]} — raw enough that future
queries can reshape without re-polling.

Runs forever. Stop with Ctrl+C or kill. Designed to be parked in a `nohup ... &`
shell or a LaunchAgent.

Reads MikroTik creds from ~/.claude-gombwe/mikrotik.json.
"""
import base64
import json
import os
import pathlib
import signal
import ssl
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

POLL_INTERVAL = 60  # seconds
CREDS_FILE = pathlib.Path.home() / ".claude-gombwe" / "mikrotik.json"
DATA_DIR = pathlib.Path.home() / ".claude-gombwe" / "data" / "network"

# Fields we keep from each MikroTik record — drop the rest to keep JSONL compact.
LEASE_FIELDS = ("address", "mac-address", "host-name", "status", "comment", "server")
ARP_FIELDS = ("address", "mac-address", "interface", "complete")
CONN_FIELDS = (
    "src-address", "dst-address", "protocol",
    "orig-bytes", "repl-bytes", "orig-packets", "repl-packets",
    "tcp-state", "timeout", "connection-mark",
)


def load_creds():
    cfg = json.loads(CREDS_FILE.read_text())
    return cfg["host"], cfg["user"], cfg["password"]


def get(host, auth_header, path, timeout=8):
    """GET https://{host}/rest/{path} with basic auth. Returns parsed JSON or raises."""
    url = f"https://{host}/rest{path}"
    req = urllib.request.Request(url, headers={"Authorization": auth_header})
    ctx = ssl._create_unverified_context()  # self-signed router cert
    with urllib.request.urlopen(req, context=ctx, timeout=timeout) as r:
        return json.loads(r.read().decode())


def strip(record, fields):
    """Keep only the fields we care about. Missing fields drop silently."""
    out = {}
    for f in fields:
        if f in record:
            out[f] = record[f]
    # connection records: split src-address into ip/port for easier downstream queries
    if "src-address" in out and ":" in out["src-address"]:
        ip, _, port = out["src-address"].rpartition(":")
        out["src-ip"] = ip
        out["src-port"] = port
    if "dst-address" in out and ":" in out["dst-address"]:
        ip, _, port = out["dst-address"].rpartition(":")
        out["dst-ip"] = ip
        out["dst-port"] = port
    return out


def snapshot(host, auth_header):
    leases = get(host, auth_header, "/ip/dhcp-server/lease")
    arp = get(host, auth_header, "/ip/arp")
    conns = get(host, auth_header, "/ip/firewall/connection")
    return {
        "ts": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "devices": [strip(l, LEASE_FIELDS) for l in leases],
        "arp": [strip(a, ARP_FIELDS) for a in arp],
        "connections": [strip(c, CONN_FIELDS) for c in conns],
    }


def jsonl_path_for(now):
    return DATA_DIR / f"{now.strftime('%Y-%m-%d')}.jsonl"


def main():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    host, user, pw = load_creds()
    auth = "Basic " + base64.b64encode(f"{user}:{pw}".encode()).decode()

    print(f"[network-monitor] started host={host} user={user} interval={POLL_INTERVAL}s", flush=True)
    print(f"[network-monitor] writing to {DATA_DIR}/", flush=True)

    # Clean exit on SIGTERM (LaunchAgent / kill)
    stopping = {"flag": False}
    def stop(*_): stopping["flag"] = True; print("[network-monitor] received signal, exiting after current snapshot", flush=True)
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)

    last_consecutive_errors = 0
    while not stopping["flag"]:
        start = time.monotonic()
        try:
            snap = snapshot(host, auth)
            path = jsonl_path_for(datetime.now())
            with open(path, "a") as f:
                f.write(json.dumps(snap) + "\n")
            n_devices = len({d.get("mac-address") for d in snap["devices"] if d.get("status") == "bound"})
            n_conn = len(snap["connections"])
            print(f"[network-monitor] {snap['ts']} devices={n_devices} connections={n_conn} → {path.name}", flush=True)
            last_consecutive_errors = 0
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError) as e:
            last_consecutive_errors += 1
            print(f"[network-monitor] poll failed ({last_consecutive_errors}x): {type(e).__name__}: {e}", file=sys.stderr, flush=True)
            # Exponential backoff capped at the poll interval, so we never *slow* the normal cadence.
            backoff = min(2 ** last_consecutive_errors, POLL_INTERVAL)
            time.sleep(backoff)
            continue
        # Sleep so the next poll is exactly POLL_INTERVAL from the start of this one.
        elapsed = time.monotonic() - start
        if not stopping["flag"]:
            time.sleep(max(0.1, POLL_INTERVAL - elapsed))

    print("[network-monitor] stopped", flush=True)


if __name__ == "__main__":
    main()
