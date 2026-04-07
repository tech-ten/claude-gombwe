# The Completion Loop

This is the core mechanism that makes gombwe different from just running `claude -p`. It ensures tasks actually get finished.

## The problem

Claude Code, when run headless with `claude -p`, may:
- Stop halfway and say "I'll continue in the next step"
- Fail due to a transient error (rate limit, timeout)
- Leave TODOs or placeholders in code
- Not verify that its changes actually work

In interactive mode, you'd notice these and tell Claude to keep going. In autonomous mode, nobody is watching.

## How the completion loop works

```
Step 1: AUTONOMY WRAPPER
   Your prompt gets prepended with instructions:
   "You are in FULLY AUTONOMOUS mode.
    NEVER ask questions. Make decisions yourself.
    NEVER stop halfway. Break work into steps and do ALL of them.
    Verify each step before moving on."

Step 2: INITIAL RUN
   claude -p "<wrapped prompt>"
   → Captures session ID for --resume

Step 3: INCOMPLETE? → CONTINUE (up to 5 times)
   Gombwe checks the output for signals of incompleteness:
   - "I'll continue"
   - "let me continue"
   - "TODO:"
   - "not yet implemented"
   - "placeholder"
   - "// ..."
   
   If detected:
   claude --resume <session-id> -p "You didn't finish. Keep going."
   → Claude has FULL context from the original run
   → It knows exactly where it left off

Step 4: FAILED? → RETRY (up to 3 times)
   If the process exits with non-zero:
   claude --resume <session-id> -p "Previous attempt failed: <error>. 
   Check project state and continue."
   → Claude remembers what it tried and can try differently

Step 5: VERIFY
   After Claude says it's done:
   claude --resume <session-id> -p "Verify your work:
   1. Check all files are syntactically valid
   2. Run tests if they exist
   3. Run the build if there is one
   4. Look for TODOs or incomplete code
   5. Fix any issues you find"
   → Same session — Claude knows every file it touched

Step 6: COMPLETE
   Only after verification passes does gombwe mark the task as completed.
```

## Why --resume is critical

Every step uses `--resume` with the same session ID. This means Claude has:
- Every file it read during the task
- Every command it ran
- Every error it encountered
- Every decision it made
- The full tool call history

This is fundamentally better than OpenClaw, which uses the stateless API and has to resend conversation history (losing internal tool state). With `--resume`, Claude's internal context is preserved — including things that never appear in the output.

## Configuration

In `src/types.ts`, the `AgentTask` interface has:

```typescript
attempt: number;        // Current attempt (1-indexed)
maxAttempts: number;    // Default: 3
continuations: number;  // How many times we've continued
maxContinuations: number; // Default: 5
verified: boolean;      // Has verification passed?
conversationId?: string; // Claude session ID for --resume
```

## Incompleteness detection heuristics

The `looksIncomplete()` method checks for these strings (case-insensitive):

```
"i'll continue"
"let me continue"
"next, i'll"
"now let me"
"i still need to"
"remaining steps"
"todo:"
"not yet implemented"
"will implement"
"placeholder"
"// ..."
"# ..."
```

These are imperfect heuristics. They may produce false positives (triggering unnecessary continuations) or miss actual incomplete work. This is an area for improvement.
