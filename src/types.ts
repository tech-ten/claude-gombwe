export interface GombweConfig {
  port: number;
  host: string;
  dataDir: string;
  skillsDirs: string[];
  agents: {
    defaultModel?: string;
    maxConcurrent: number;
    workingDir: string;
  };
  channels: {
    telegram?: { botToken: string };
    discord?: { botToken: string };
    web?: { enabled: boolean };
  };
  identity: {
    name: string;
    personality?: string;
  };
}

export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface AgentTask {
  id: string;
  prompt: string;
  status: TaskStatus;
  channel: string;
  sessionKey: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  output: string[];
  error?: string;
  workingDir?: string;
  pid?: number;
  // Completion loop tracking
  attempt: number;
  maxAttempts: number;
  continuations: number;
  maxContinuations: number;
  verified: boolean;
  conversationId?: string;
}

export interface Session {
  key: string;
  channel: string;
  createdAt: string;
  lastActiveAt: string;
  transcript: TranscriptEntry[];
  // Claude CLI session ID — used for --resume to continue conversations
  claudeSessionId?: string;
  // What mode this session is in
  mode: 'chat' | 'task';
}

export interface TranscriptEntry {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
  channel: string;
}

export interface Skill {
  name: string;
  description: string;
  version: string;
  userInvocable: boolean;
  disableModelInvocation: boolean;
  direct: boolean; // If true, execute tool directly — skip Claude entirely
  instructions: string;
  path: string;
  // Tools — executable actions the skill can perform directly
  tools?: SkillTool[];
}

export interface SkillTool {
  name: string;
  description: string;
  type: 'shell' | 'http' | 'script';
  // For shell: the command to run
  command?: string;
  // For http: URL, method, headers
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  // For script: path to a script file (relative to skill dir)
  script?: string;
}

export interface CronJob {
  id: string;
  expression: string;
  timezone: string;
  prompt: string;
  channel: string;
  sessionKey: string;
  enabled: boolean;
  lastRun?: string;
  nextRun?: string;
}

// --- Event Triggers ---
// "When X happens, do Y" — the core of proactive behavior

export interface EventTrigger {
  id: string;
  name: string;
  enabled: boolean;
  // What to watch for
  source: TriggerSource;
  // What to do when triggered
  action: TriggerAction;
  // Optional: only trigger if this condition is met (evaluated by Claude)
  condition?: string;
  // Polling interval in seconds (for poll-based triggers)
  pollInterval: number;
  // State
  lastChecked?: string;
  lastTriggered?: string;
  triggerCount: number;
}

export type TriggerSource =
  | { type: 'poll_prompt'; prompt: string }         // Ask Claude to check something
  | { type: 'webhook'; path: string }               // External HTTP POST triggers it
  | { type: 'file_watch'; path: string }             // File/dir changes
  | { type: 'url_change'; url: string; selector?: string }  // Web page changes
  | { type: 'schedule'; expression: string };        // Cron-like but with conditions

export interface TriggerAction {
  prompt: string;                    // What to tell Claude to do
  notify?: string[];                 // Channels to send result to (e.g. ["telegram", "web"])
  chain?: TriggerAction[];           // Chain of follow-up actions (workflow)
}

// --- Workflows ---
// Multi-step: step 1 output feeds into step 2, etc.

export interface Workflow {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  trigger: TriggerSource;
  steps: WorkflowStep[];
  createdAt: string;
  lastRun?: string;
  runCount: number;
}

export interface WorkflowStep {
  name: string;
  prompt: string;                    // Can use {{previous}} to reference prior step output
  condition?: string;                // Skip this step if condition not met
  notify?: string[];                 // Send this step's output to channels
}

export interface ChannelAdapter {
  name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  send(sessionKey: string, message: string): Promise<void>;
  onMessage(handler: MessageHandler): void;
}

export type MessageHandler = (msg: IncomingMessage) => Promise<void>;

export interface IncomingMessage {
  channel: string;
  sessionKey: string;
  text: string;
  sender: string;
  timestamp: string;
}

export type WSEventType =
  | 'task:created'
  | 'task:started'
  | 'task:output'
  | 'task:completed'
  | 'task:failed'
  | 'session:message';

export interface WSEvent {
  type: WSEventType;
  data: unknown;
  timestamp: string;
}
