---
name: api-health
description: Check if your APIs and websites are up and responding
version: 1.0.0
user-invocable: true
tools:
  - name: check-url
    description: Check if a URL is responding
    type: http
    url: "https://httpstat.us/200"
    method: GET
  - name: check-dns
    description: DNS lookup
    type: shell
    command: "nslookup google.com | tail -4"
  - name: check-ports
    description: Check common local ports
    type: shell
    command: "for port in 3000 5173 8080 18790; do (echo > /dev/tcp/127.0.0.1/$port) 2>/dev/null && echo \"Port $port: OPEN\" || echo \"Port $port: closed\"; done"
---

# API Health Check

Check the health of APIs and services:

1. Run each health check tool
2. Report which services are up and which are down
3. Flag any concerning response times
4. Suggest actions for any issues found

The user may specify custom URLs to check. If they do, use the fetch MCP to check those URLs as well.
