import * as fs from "node:fs";
import { SESSIONS_FILE, saveConfig } from "./config.js";
import { DEFAULT_MODE, SESSION_NAME_PREFIX, PREVIEW } from "./constants.js";
import type { LlmMessage } from "./llm.js";
import { agentTurn, MODE_PROMPTS, buildToolsForAgent } from "./agent.js";
import type { LogFn } from "./tools.js";

export interface ChatSessionData {
  mode: string;
  messages: LlmMessage[];
}

export class ChatSession {
  mode: string;
  unsaved: boolean;
  messages: LlmMessage[];

  constructor(mode: string = DEFAULT_MODE, unsaved: boolean = false) {
    this.mode = mode;
    this.unsaved = unsaved;
    this.messages = [{ role: "system", content: MODE_PROMPTS[this.mode] }];
  }

  setMode(mode: string): void {
    if (!(mode in MODE_PROMPTS)) return;
    this.mode = mode;
    // Swap the system prompt for subsequent turns; prior history is kept.
    this.messages[0] = { role: "system", content: MODE_PROMPTS[mode] };
  }

  reset(): void {
    const mode = this.mode;
    this.messages = [{ role: "system", content: MODE_PROMPTS[mode] }];
  }

  async send(userText: string, log: LogFn = console.log): Promise<string> {
    this.messages.push({ role: "user", content: userText });
    const tools = buildToolsForAgent(this.mode, 0, log);
    const answer = await agentTurn(this.messages, tools, log, undefined, false);
    this.messages.push({ role: "assistant", content: answer });
    return answer;
  }

  toJSON(): ChatSessionData {
    return { mode: this.mode, messages: this.messages };
  }

  static fromJSON(data: ChatSessionData): ChatSession {
    const session = new ChatSession(data.mode, false);
    session.messages = data.messages || [{ role: "system", content: MODE_PROMPTS[data.mode] }];
    return session;
  }
}

export interface SessionManagerData {
  order: string[];
  current: string;
  counter: number;
  sessions: Record<string, ChatSessionData>;
}

export class SessionManager {
  sessions: Map<string, ChatSession>;
  order: string[];
  current: string;
  _counter: number;

  constructor() {
    this.sessions = new Map();
    this.order = [];
    this.current = "";
    this._counter = 0;
    this.newSession(undefined, DEFAULT_MODE, true); // start with an empty unsaved session
  }

  private _nextName(): string {
    this._counter++;
    return `${SESSION_NAME_PREFIX}${this._counter}`;
  }

  newSession(
    name?: string,
    mode: string = DEFAULT_MODE,
    unsaved: boolean = false
  ): string {
    const sessionName = (name || "").trim() || this._nextName();
    if (this.sessions.has(sessionName)) {
      throw new Error(
        `session '${sessionName}' already exists — use /sessions ${sessionName} to switch to it.`
      );
    }
    this.sessions.set(sessionName, new ChatSession(mode, unsaved));
    this.order.push(sessionName);
    this.current = sessionName;
    return sessionName;
  }

  switch(name: string): void {
    if (!this.sessions.has(name)) {
      throw new Error(`Unknown session '${name}'`);
    }
    this.current = name;
  }

  get active(): ChatSession {
    return this.sessions.get(this.current)!;
  }

  listText(): string {
    const lines: string[] = [];
    for (const name of this.order) {
      const s = this.sessions.get(name)!;
      const marker = name === this.current ? "*" : " ";
      const nMsgs = s.messages.filter((m) => m.role === "user").length;
      const preview =
        [...s.messages]
          .reverse()
          .find((m) => m.role === "user")
          ?.content?.toString()
          .slice(0, PREVIEW.session) || "";
      const suffix = preview ? ` — "${preview}"` : "";
      const msgLabel = nMsgs !== 1 ? "msgs" : "msg";
      lines.push(
        `${marker} ${name} [${s.mode}] ${nMsgs} ${msgLabel}${suffix}`
      );
    }
    return lines.join("\n");
  }

  toJSON(): SessionManagerData {
    const savedSessions: Record<string, ChatSessionData> = {};
    for (const [name, s] of this.sessions) {
      if (!s.unsaved) {
        savedSessions[name] = s.toJSON();
      }
    }
    return {
      order: this.order.filter((n) => !this.sessions.get(n)?.unsaved),
      current: this.current,
      counter: this._counter,
      sessions: savedSessions,
    };
  }

  static fromJSON(data: SessionManagerData): SessionManager {
    const manager = new SessionManager();
    manager.sessions.clear();
    manager.order = [];
    manager._counter = data.counter || 0;

    for (const name of data.order) {
      const sData = data.sessions[name];
      if (!sData) continue;
      manager.sessions.set(name, ChatSession.fromJSON(sData));
      manager.order.push(name);
    }

    if (manager.sessions.size === 0) {
      return new SessionManager(); // fallback to fresh
    }

    manager.current =
      data.current && manager.sessions.has(data.current)
        ? data.current
        : manager.order[0];

    // Add an empty unsaved session on top (like Python version)
    manager.newSession(undefined, DEFAULT_MODE, true);

    return manager;
  }
}

export function saveSessions(manager: SessionManager): void {
  const state = manager.toJSON();
  try {
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(state, null, 2), "utf-8");
  } catch (e) {
    console.error(`⚠️  Could not save sessions to ${SESSIONS_FILE}: ${e}`);
  }
}

export function loadSessions(): SessionManager | null {
  if (!fs.existsSync(SESSIONS_FILE)) return null;
  try {
    const raw = fs.readFileSync(SESSIONS_FILE, "utf-8");
    const state: SessionManagerData = JSON.parse(raw);

    if (
      !state.order ||
      state.order.length === 0 ||
      !state.sessions ||
      Object.keys(state.sessions).length === 0
    ) {
      return null;
    }

    return SessionManager.fromJSON(state);
  } catch (e) {
    console.error(
      `⚠️  Could not load ${SESSIONS_FILE} (${e}), starting fresh.`
    );
    return null;
  }
}

export function saveState(manager: SessionManager): void {
  saveConfig();
  saveSessions(manager);
}

export function loadState(): SessionManager | null {
  // loadConfig is called externally before this
  return loadSessions();
}
