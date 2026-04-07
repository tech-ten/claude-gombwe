# REST API

The gateway exposes a REST API at `http://localhost:18790/api`.

## Tasks

### Create a task
```
POST /api/tasks
Content-Type: application/json

{
  "prompt": "Build me a landing page",
  "channel": "web",
  "sessionKey": "web:12345",
  "workingDir": "/path/to/project"    // optional
}

Response: 201
{
  "id": "uuid",
  "prompt": "...",
  "status": "running",
  "pid": 12345,
  ...
}
```

### List tasks
```
GET /api/tasks
GET /api/tasks?status=running

Response: 200
[{ "id": "...", "status": "running", "prompt": "...", ... }]
```

### Get a task
```
GET /api/tasks/:id

Response: 200
{ "id": "...", "status": "completed", "output": [...], ... }
```

### Cancel a task
```
POST /api/tasks/:id/cancel

Response: 200
{ "ok": true }
```

## Sessions

### List sessions
```
GET /api/sessions

Response: 200
[{ "key": "discord:guild:channel", "channel": "discord", "messageCount": 15, ... }]
```

### Get a session (with transcript)
```
GET /api/sessions/:key

Response: 200
{ "key": "...", "transcript": [{ "role": "user", "content": "...", ... }], ... }
```

## Skills

### List skills
```
GET /api/skills

Response: 200
[{ "name": "email-digest", "description": "...", "tools": [...], ... }]
```

### Reload skills
```
POST /api/skills/reload

Response: 200
{ "count": 13 }
```

## Cron Jobs

### List jobs
```
GET /api/cron

Response: 200
[{ "id": "...", "expression": "0 9 * * *", "prompt": "...", "enabled": true, ... }]
```

### Create a job
```
POST /api/cron
Content-Type: application/json

{
  "expression": "0 9 * * *",
  "prompt": "/morning-briefing",
  "channel": "cron",
  "sessionKey": "cron:12345",
  "timezone": "UTC"
}

Response: 201
{ "id": "...", "nextRun": "...", ... }
```

### Delete a job
```
DELETE /api/cron/:id
```

### Toggle a job
```
POST /api/cron/:id/toggle
Content-Type: application/json

{ "enabled": false }
```

## Event Triggers

### List triggers
```
GET /api/triggers
```

### Create a trigger
```
POST /api/triggers
Content-Type: application/json

{
  "name": "client-email",
  "source": { "type": "poll_prompt", "prompt": "Check inbox for emails from @client.com" },
  "action": { "prompt": "Summarize and draft a reply", "notify": ["discord:#alerts"] },
  "pollInterval": 300,
  "condition": null
}
```

### Delete a trigger
```
DELETE /api/triggers/:id
```

### Toggle a trigger
```
POST /api/triggers/:id/toggle
Content-Type: application/json

{ "enabled": false }
```

## Workflows

### List workflows
```
GET /api/workflows
```

### Create a workflow
```
POST /api/workflows
Content-Type: application/json

{
  "name": "pr-review",
  "description": "Review PRs and notify on Discord",
  "trigger": { "type": "webhook", "path": "github-pr" },
  "steps": [
    { "name": "review", "prompt": "Review the code changes" },
    { "name": "notify", "prompt": "Summarize: {{previous}}", "notify": ["discord:#github"] }
  ]
}
```

### Run a workflow manually
```
POST /api/workflows/:id/run
Content-Type: application/json

{ "context": "optional trigger context" }
```

### Delete a workflow
```
DELETE /api/workflows/:id
```

## Webhooks

Webhooks trigger matching event triggers AND workflows:

```
POST /api/webhook/:path
Content-Type: application/json

{ ...any body... }

Response: 200
{ "triggered": 2, "triggers": ["name1"], "workflows": ["name2"] }
```

## Status

```
GET /api/status

Response: 200
{
  "name": "Gombwe",
  "uptime": 3600,
  "tasks": { "running": 2, "total": 15 },
  "channels": ["web", "discord"],
  "skills": 13,
  "cronJobs": 3,
  "wsClients": 2
}
```

## WebSocket

Connect to `ws://localhost:18790` for real-time events:

### Event types
```json
{ "type": "task:created",   "data": { task object } }
{ "type": "task:started",   "data": { task object } }
{ "type": "task:output",    "data": { "taskId": "...", "text": "..." } }
{ "type": "task:completed", "data": { task object } }
{ "type": "task:failed",    "data": { task object } }
{ "type": "session:message","data": { "sessionKey": "...", "message": "...", "channel": "..." } }
```

### Sending chat messages
```json
{ "type": "chat", "text": "hello", "sessionKey": "web:12345" }
```
