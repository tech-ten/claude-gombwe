---
name: system-health
description: Check system health — disk, memory, CPU, running processes
version: 1.0.0
user-invocable: true
tools:
  - name: disk-usage
    description: Check disk usage
    type: shell
    command: "df -h / | tail -1"
  - name: memory
    description: Check memory usage
    type: shell
    command: "vm_stat | head -5"
  - name: top-processes
    description: List top CPU-consuming processes
    type: shell
    command: "ps aux --sort=-%cpu | head -6"
  - name: uptime
    description: System uptime and load averages
    type: shell
    command: "uptime"
---

# System Health Check

Run the system health tools and summarize the results:

1. Check disk usage — flag if any partition is above 80%
2. Check memory — report available vs used
3. List top CPU consumers — flag anything unusual
4. Report uptime and load averages

Present as a clean health report with status indicators.
