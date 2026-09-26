# 12. The dashboard is one instrument panel design system

## Status

Accepted, 2026-09-27.

## Context

The dashboard grew a tab at a time. The shell is warm cream and terracotta, the Family page is a later clean blue, and the tabs in between each carry their own spacing, type and card treatment. This build adds Home, Goals, Activity, Memory, Monitors and Permissions, which would make the drift worse and make the whole thing read as a prototype.

The dashboard is also becoming the household's shared control panel, and the partner's main surface after WhatsApp is this page on a phone.

## Decision

One design system across every tab, extending the Family page rather than the old shell: the system font stack, hairline dividers, flat cards, dense tables, restrained motion, and both light and dark. It should read as an instrument panel, precise and finished, with the control and the detail kept and the decoration dropped. Copy is plain English, with no exclamation marks and no emoji. Layout is mobile first. The sidebar shows only the tabs the signed in principal is granted, which is where per-principal permissions become visible. Chat renders approval requests inline with buttons and shows a chip on an action that links to its ledger entry.

## Consequences

Tabs look like one product and a new tab has a pattern to follow. Existing markup and styles are rewritten once, which touches every tab. Density has to survive a phone screen, so tables need a narrow layout rather than horizontal scrolling. Healthy sidecar subsystems stay silent and surface only when something is wrong.

## Alternatives considered

A component framework and a third party design system. Rejected; the dashboard is plain HTML, CSS and JavaScript served by the gateway, and a build step would cost more than it returns. Restyling only the new tabs. Rejected; that is the current problem.
