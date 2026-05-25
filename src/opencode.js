const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const DEFAULT_OPENCODE_ROOT = path.join(os.homedir(), ".local", "share", "opencode", "storage");

function getOpenCodeRoot() {
  return process.env.OPENCODE_DATA_DIR
    ? path.join(process.env.OPENCODE_DATA_DIR, "storage")
    : DEFAULT_OPENCODE_ROOT;
}

function walkDirectories(dirPath) {
  if (!fs.existsSync(dirPath)) return [];
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory()).map((e) => path.join(dirPath, e.name));
}

function readJsonFile(filePath) {
  const text = fs.readFileSync(filePath, "utf8");
  return JSON.parse(text);
}

function listOpenCodeSessions({ root, limit = 10 }) {
  const storageRoot = root || getOpenCodeRoot();
  const sessionDir = path.join(storageRoot, "session");
  if (!fs.existsSync(sessionDir)) return [];

  const projectDirs = walkDirectories(sessionDir);
  const sessions = [];

  for (const projectDir of projectDirs) {
    const sessionFiles = fs
      .readdirSync(projectDir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".json"))
      .map((e) => path.join(projectDir, e.name));

    for (const sessionFile of sessionFiles) {
      try {
        const session = readJsonFile(sessionFile);
        sessions.push({
          filePath: sessionFile,
          sessionId: session.id,
          projectId: session.projectID,
          directory: session.directory,
          title: session.title || "(no title)",
          createdAt: session.time?.created ? new Date(session.time.created).toISOString() : null,
          updatedAt: session.time?.updated ? new Date(session.time.updated).toISOString() : null,
          slug: session.slug || "",
          version: session.version || "",
        });
      } catch {
        // skip unreadable sessions
      }
    }
  }

  sessions.sort((a, b) => (b.updatedAt || b.createdAt || "").localeCompare(a.updatedAt || a.createdAt || ""));
  return sessions.slice(0, limit);
}

function resolveOpenCodeSessionTarget({ root, target }) {
  const storageRoot = root || getOpenCodeRoot();
  const sessions = listOpenCodeSessions({ root: storageRoot, limit: 10000 });
  if (sessions.length === 0) {
    throw new Error(`No OpenCode sessions found under ${storageRoot}`);
  }

  if (!target || target === "last") return sessions[0]?.filePath;
  if (fs.existsSync(target)) return path.resolve(target);

  const exact = sessions.find((s) => s.sessionId === target);
  if (exact) return exact.filePath;

  const partial = sessions.filter(
    (s) => s.sessionId.includes(target) || s.slug.includes(target) || path.basename(s.filePath).includes(target),
  );
  if (partial.length === 1) return partial[0].filePath;
  if (partial.length > 1) throw new Error(`OpenCode target is ambiguous: ${target}`);
  throw new Error(`Could not find OpenCode session matching: ${target}`);
}

function getMessageFiles(sessionId, storageRoot) {
  const messageDir = path.join(storageRoot, "message", sessionId);
  if (!fs.existsSync(messageDir)) return [];
  return fs
    .readdirSync(messageDir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".json"))
    .map((e) => path.join(messageDir, e.name))
    .sort();
}

function getMessageText(messageId, storageRoot) {
  const partDir = path.join(storageRoot, "part", messageId);
  if (!fs.existsSync(partDir)) return "";
  const partFiles = fs
    .readdirSync(partDir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".json"))
    .sort();
  const texts = partFiles.map((f) => {
    try {
      const part = readJsonFile(path.join(partDir, f.name));
      return part.text || "";
    } catch {
      return "";
    }
  });
  return texts.join("\n").trim();
}

function parseOpenCodeSession(sessionFilePath, { root = null } = {}) {
  const storageRoot = root || getOpenCodeRoot();
  const session = readJsonFile(sessionFilePath);
  const sessionId = session.id;
  const messageFiles = getMessageFiles(sessionId, storageRoot);

  const transcript = [];
  for (const msgFile of messageFiles) {
    try {
      const msg = readJsonFile(msgFile);
      const text = getMessageText(msg.id, storageRoot);
      if (!text) continue;
      transcript.push({
        role: msg.role,
        text,
        timestamp: msg.time?.created ? new Date(msg.time.created).toISOString() : new Date().toISOString(),
        model: msg.model?.modelID || "",
        agent: msg.agent || "",
      });
    } catch {
      // skip unreadable messages
    }
  }
  transcript.sort((a, b) => (a.timestamp || "").localeCompare(b.timestamp || ""));

  return {
    sessionId,
    slug: session.slug || "",
    directory: session.directory || "",
    title: session.title || "",
    createdAt: session.time?.created ? new Date(session.time.created).toISOString() : null,
    updatedAt: session.time?.updated ? new Date(session.time.updated).toISOString() : null,
    projectId: session.projectID || "",
    version: session.version || "",
    transcript,
    originalCwd: session.directory || process.cwd(),
    model: transcript.find((t) => t.role === "assistant")?.model || "kimi-k2.5-free",
  };
}

function generateSessionId() {
  return `ses_${crypto.randomBytes(18).toString("hex")}`;
}

function generateMessageId() {
  return `msg_${crypto.randomBytes(18).toString("hex")}`;
}

function copyOpenCodeSession({ sourceRoot, targetRoot, target, newSessionId = null }) {
  const storageRoot = sourceRoot || getOpenCodeRoot();
  const sessionFile = resolveOpenCodeSessionTarget({ root: storageRoot, target });
  const session = readJsonFile(sessionFile);
  const sessionId = newSessionId || generateSessionId();

  const now = Date.now();
  const newSession = {
    ...session,
    id: sessionId,
    slug: session.slug || "copied-session",
    time: { created: now, updated: now },
  };

  const targetStorageRoot = targetRoot || storageRoot;
  const projectDir = path.join(targetStorageRoot, "session", session.projectID || "copied");
  fs.mkdirSync(projectDir, { recursive: true });
  const newSessionPath = path.join(projectDir, `${sessionId}.json`);
  fs.writeFileSync(newSessionPath, JSON.stringify(newSession, null, 2));

  const srcMessageDir = path.join(storageRoot, "message", session.id);
  if (fs.existsSync(srcMessageDir)) {
    const destMessageDir = path.join(targetStorageRoot, "message", sessionId);
    fs.mkdirSync(destMessageDir, { recursive: true });
    const msgFiles = fs.readdirSync(srcMessageDir).filter((f) => f.endsWith(".json"));
    for (const msgFile of msgFiles) {
      const msgPath = path.join(srcMessageDir, msgFile);
      const msg = readJsonFile(msgPath);
      const newMsgId = generateMessageId();
      const newMsg = { ...msg, id: newMsgId, sessionID: sessionId };
      fs.writeFileSync(path.join(destMessageDir, `${newMsgId}.json`), JSON.stringify(newMsg, null, 2));

      const srcPartDir = path.join(storageRoot, "part", msg.id);
      if (fs.existsSync(srcPartDir)) {
        const destPartDir = path.join(targetStorageRoot, "part", newMsgId);
        fs.mkdirSync(destPartDir, { recursive: true });
        const partFiles = fs.readdirSync(srcPartDir).filter((f) => f.endsWith(".json"));
        for (const partFile of partFiles) {
          const partPath = path.join(srcPartDir, partFile);
          const part = readJsonFile(partPath);
          const newPart = { ...part, messageID: newMsgId };
          fs.writeFileSync(path.join(destPartDir, partFile), JSON.stringify(newPart, null, 2));
        }
      }
    }
  }

  return {
    sourceFile: sessionFile,
    targetFile: newSessionPath,
    sourceSessionId: session.id,
    sessionId,
  };
}

function generateOpenCodeSessionFromT3({
  t3Thread,
  targetRoot = null,
  sessionId = null,
}) {
  const now = Date.now();
  const id = sessionId || generateSessionId();
  const projectId = crypto.createHash("sha1").update(t3Thread.workspaceRoot || process.cwd()).digest("hex").slice(0, 40);

  const session = {
    id,
    slug: t3Thread.title?.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40) || "imported-session",
    version: "1.1.40",
    projectID: projectId,
    directory: t3Thread.workspaceRoot || process.cwd(),
    title: t3Thread.title || "(imported from T3)",
    time: {
      created: now,
      updated: now,
    },
    summary: { additions: 0, deletions: 0, files: 0 },
  };

  const storageRoot = targetRoot || getOpenCodeRoot();
  const projectDir = path.join(storageRoot, "session", projectId);
  fs.mkdirSync(projectDir, { recursive: true });
  const sessionPath = path.join(projectDir, `${id}.json`);
  fs.writeFileSync(sessionPath, JSON.stringify(session, null, 2));

  const messageDir = path.join(storageRoot, "message", id);
  fs.mkdirSync(messageDir, { recursive: true });

  let msgIndex = 0;
  for (const msg of t3Thread.messages) {
    msgIndex++;
    const msgId = generateMessageId();
    const msgTime = new Date(new Date(t3Thread.createdAt).getTime() + msgIndex * 1000);
    const message = {
      id: msgId,
      sessionID: id,
      role: msg.role,
      time: { created: msgTime.getTime(), completed: msgTime.getTime() },
      parentID: null,
      modelID: t3Thread.modelSelection?.model || "kimi-k2.5-free",
      providerID: "opencode",
      mode: "build",
      agent: "build",
      path: { cwd: session.directory, root: session.directory },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      finish: "stop",
    };
    fs.writeFileSync(path.join(messageDir, `${msgId}.json`), JSON.stringify(message, null, 2));

    const partDir = path.join(storageRoot, "part", msgId);
    fs.mkdirSync(partDir, { recursive: true });
    const partId = `prt_${crypto.randomBytes(18).toString("hex")}`;
    const part = {
      id: partId,
      sessionID: id,
      messageID: msgId,
      type: "text",
      text: msg.text || "",
    };
    fs.writeFileSync(path.join(partDir, `${partId}.json`), JSON.stringify(part, null, 2));
  }

  return {
    sessionId: id,
    sessionPath,
    messageCount: t3Thread.messages.length,
    sourceThreadId: t3Thread.threadId,
  };
}

module.exports = {
  DEFAULT_OPENCODE_ROOT,
  listOpenCodeSessions,
  resolveOpenCodeSessionTarget,
  parseOpenCodeSession,
  copyOpenCodeSession,
  generateOpenCodeSessionFromT3,
};
