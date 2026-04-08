import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execSync, spawn } from 'node:child_process';
import { globSync } from 'glob';
import matter from 'gray-matter';
import type { Skill, SkillTool } from './types.js';

export class SkillLoader {
  private skills: Map<string, Skill> = new Map();
  private dirs: string[];

  constructor(skillsDirs: string[]) {
    this.dirs = skillsDirs;
  }

  load(): void {
    this.skills.clear();

    for (const dir of this.dirs) {
      if (!existsSync(dir)) continue;

      const skillFiles = globSync('**/SKILL.md', { cwd: dir, absolute: true });

      for (const filePath of skillFiles) {
        try {
          const skill = this.parseSkill(filePath);
          if (skill) {
            this.skills.set(skill.name, skill);
          }
        } catch {
          // Skip invalid skills
        }
      }
    }
  }

  private parseSkill(filePath: string): Skill | null {
    const raw = readFileSync(filePath, 'utf-8');
    const { data, content } = matter(raw);

    if (!data.name || !data.description) return null;

    // Parse tools from frontmatter
    let tools: SkillTool[] | undefined;
    if (data.tools && Array.isArray(data.tools)) {
      tools = data.tools.map((t: any) => ({
        name: t.name,
        description: t.description || '',
        type: t.type || 'shell',
        command: t.command,
        url: t.url,
        method: t.method || 'GET',
        headers: t.headers,
        body: t.body,
        script: t.script,
      }));
    }

    return {
      name: data.name,
      description: data.description || '',
      version: data.version || '0.0.0',
      userInvocable: data['user-invocable'] !== false,
      disableModelInvocation: data['disable-model-invocation'] === true,
      direct: data['direct'] === true,
      instructions: content.trim(),
      path: filePath,
      tools,
    };
  }

  getSkill(name: string): Skill | undefined {
    return this.skills.get(name);
  }

  listSkills(): Skill[] {
    return Array.from(this.skills.values());
  }

  getInvocableSkills(): Skill[] {
    return this.listSkills().filter(s => s.userInvocable);
  }

  buildSkillsPrompt(): string {
    const skills = this.listSkills().filter(s => !s.disableModelInvocation);
    if (skills.length === 0) return '';

    const entries = skills.map(s => {
      let toolDocs = '';
      if (s.tools && s.tools.length > 0) {
        toolDocs = '\n\nThis skill has executable tools. Use them by outputting:\n```\n[TOOL: tool-name]\n```\n\nAvailable tools:\n';
        toolDocs += s.tools.map(t => `- ${t.name}: ${t.description}`).join('\n');
      }
      return `<skill name="${s.name}" description="${s.description}">\n${s.instructions}${toolDocs}\n</skill>`;
    });

    return `<available-skills>\n${entries.join('\n')}\n</available-skills>`;
  }
}

/**
 * Execute a skill tool directly — no AI needed for the mechanical part.
 */
export async function executeSkillTool(tool: SkillTool, skillDir: string): Promise<string> {
  switch (tool.type) {
    case 'shell': {
      if (!tool.command) return 'Error: no command specified';
      try {
        const output = execSync(tool.command, {
          cwd: skillDir,
          timeout: 30000,
          encoding: 'utf-8',
          env: { ...process.env },
        });
        return output.trim();
      } catch (err: any) {
        return `Error: ${err.stderr || err.message}`;
      }
    }

    case 'http': {
      if (!tool.url) return 'Error: no url specified';
      try {
        const res = await fetch(tool.url, {
          method: tool.method || 'GET',
          headers: tool.headers,
          body: tool.method !== 'GET' ? tool.body : undefined,
        });
        const text = await res.text();
        return `Status: ${res.status}\n${text.slice(0, 5000)}`;
      } catch (err: any) {
        return `Error: ${err.message}`;
      }
    }

    case 'script': {
      if (!tool.script) return 'Error: no script specified';
      const scriptPath = join(skillDir, tool.script);
      if (!existsSync(scriptPath)) return `Error: script not found: ${scriptPath}`;
      try {
        const output = execSync(`bash "${scriptPath}"`, {
          cwd: skillDir,
          timeout: 60000,
          encoding: 'utf-8',
          env: { ...process.env },
        });
        return output.trim();
      } catch (err: any) {
        return `Error: ${err.stderr || err.message}`;
      }
    }

    default:
      return `Error: unknown tool type ${tool.type}`;
  }
}
