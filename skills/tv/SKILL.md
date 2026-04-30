---
name: tv
description: Control an Android / Google TV (e.g. TCL) over the network — set Private DNS to block YouTube and other apps, send keys, launch apps, reboot
version: 0.1.0
user-invocable: true
tools:
  - name: status
    type: shell
    description: Show ADB connection state and the TV's current Private DNS setting. Fails clearly if ADB isn't enabled on the TV yet.
    command: "node scripts/tv.mjs status"
  - name: connect
    type: shell
    description: Open an ADB connection to the registered TV. Triggers an "Allow ADB?" popup on the TV the first time — the user must tap Allow with their remote (or a phone-as-remote app).
    command: "node scripts/tv.mjs connect"
  - name: block-youtube
    type: shell
    description: Set the TV's Private DNS to the gombwe-configured NextDNS hostname so YouTube is blocked at DNS level. Combine with "click YouTube" in the Access Control tab if not already on the NextDNS denylist.
    command: "node scripts/tv.mjs block-youtube"
  - name: unblock
    type: shell
    description: Clear the TV's Private DNS — sites blocked by NextDNS resolve normally again.
    command: "node scripts/tv.mjs unblock"
  - name: reboot
    type: shell
    description: Reboot the TV.
    command: "node scripts/tv.mjs reboot"
  - name: home
    type: shell
    description: Send the HOME key to the TV.
    command: "node scripts/tv.mjs key home"
---

# tv

Control an Android-based TV (TCL Android TV / Google TV / Mi Box / generic Android STB) over the network from gombwe, without ever touching the physical remote — once ADB has been authorised on the TV one time.

## Why this exists

Smart TVs aren't covered by NextDNS profiles or per-device pause buttons in the eero app. Without eero Plus, the dashboard can't push DNS to the TV either. ADB is the only realistic surface for surgical control like "block YouTube, leave Disney+ alone."

## One-time setup on the TV

The TV's developer mode and ADB-over-network must be enabled. This needs the remote — physical or a phone-as-remote app:

- **Google TV / Android TV remote app** (free, by Google) — pairs over Wi-Fi and acts as a remote
- **TCL TV+** app for TCL-branded TVs

Steps on the TV:

1. **Settings** → **Device Preferences** → **About**
2. Find **Build** → press **OK seven times** → "You are now a developer"
3. Back out → **Developer options** → enable both:
   - **USB debugging**
   - **Network debugging** (or "Wireless debugging" on newer Android)
4. Note the IP and port (default `5555`)

## One-time setup on gombwe

```
brew install android-platform-tools           # if not already
node scripts/tv.mjs register 192.168.4.35     # the TV's IP, port defaults to 5555
node scripts/tv.mjs connect                   # TV will pop up "Allow ADB?" — tap Allow
node scripts/tv.mjs status                    # confirm "Connected via ADB: yes"
```

## Daily use

```
node scripts/tv.mjs block-youtube     # sets Private DNS to NextDNS — YouTube blocked
node scripts/tv.mjs unblock           # clears Private DNS
node scripts/tv.mjs status            # see what's currently configured
node scripts/tv.mjs key home          # navigate
node scripts/tv.mjs reboot
```

## How blocking actually works

`block-youtube` sets the TV's `private_dns_specifier` to the NextDNS DoT hostname (`<config-id>.dns.nextdns.io`). All DNS queries from the TV — including those issued by the YouTube app — go through NextDNS over an encrypted channel. NextDNS returns NXDOMAIN for any domain in the denylist. The YouTube app cannot resolve `*.googlevideo.com` or `youtube.com` and shows a "no internet" message. Other streaming apps that use different domains continue to work.

The block requires the YouTube domains to actually be in the NextDNS denylist for the configured profile. Set this in the gombwe Access Control tab → Website filtering → click the **YouTube** pill (it turns red). Or via the NextDNS web UI.

## Connection state

ADB-over-network is per-boot on most Android TVs — the TV may need re-authorising after a power cycle. `tv connect` is idempotent and re-establishes the link. If it fails with "unauthorized", check the TV for an authorise prompt. If it fails with "connection refused", developer mode / network debugging has been turned off.
