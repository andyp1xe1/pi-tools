import { Database, type SQLQueryBindings } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { closeSync, constants, fchmodSync, fstatSync, openSync } from "node:fs";
import { basename } from "node:path";
import * as v from "valibot";
import { preparePrivatePath } from "./config.ts";
import {
  type Binding,
  type Container,
  containerKey,
  type MessageId,
  MessageIdSchema,
  type Project,
  type ProjectId,
  ProjectIdSchema,
  ProjectSchema,
  parseContainerKey,
  type Task,
  type TaskId,
  TaskIdSchema,
  type TaskInput,
  TaskInputSchema,
  TaskSchema,
  type UserId,
  UserIdSchema,
} from "./domain.ts";
import { LocalPathSchema, StatisticsSchema } from "./protocol.ts";

const integer = v.pipe(v.number(), v.integer());
const TaskRowSchema = v.pipe(
  v.object({
    id: v.string(),
    project_id: v.string(),
    container: v.string(),
    root_id: v.string(),
    title: v.string(),
    created_at: v.string(),
  }),
  v.transform(
    (row) =>
      ({
        id: row.id,
        projectId: row.project_id,
        container: parseContainerKey(row.container),
        rootId: row.root_id,
        title: row.title,
        createdAt: row.created_at,
      }) satisfies v.InferInput<typeof TaskSchema>,
  ),
  TaskSchema,
);
const InputRowSchema = v.pipe(
  v.object({
    sequence: integer,
    task_id: v.string(),
    message_id: v.string(),
    author_id: v.string(),
    text: v.string(),
    created_at: v.string(),
  }),
  v.transform(
    (row) =>
      ({
        sequence: row.sequence,
        taskId: row.task_id,
        messageId: row.message_id,
        authorId: row.author_id,
        text: row.text,
        createdAt: row.created_at,
      }) satisfies v.InferInput<typeof TaskInputSchema>,
  ),
  TaskInputSchema,
);
const ReplyRowSchema = v.pipe(
  v.object({
    id: integer,
    transport_id: v.string(),
    container: v.string(),
    reply_to_id: MessageIdSchema,
    task_id: v.nullable(TaskIdSchema),
    text: v.string(),
    attempts: integer,
    available_at: integer,
  }),
  v.transform((row) => ({
    id: row.id,
    transportId: row.transport_id,
    container: parseContainerKey(row.container),
    replyToId: row.reply_to_id,
    taskId: row.task_id,
    text: row.text,
    attempts: row.attempts,
    availableAt: row.available_at,
  })),
);
export type PendingReply = v.InferOutput<typeof ReplyRowSchema>;

const TaskAttachmentRowSchema = v.pipe(
  v.object({
    task_id: TaskIdSchema,
    session_id: v.pipe(v.string(), v.nonEmpty(), v.maxLength(128)),
    owner_id: v.pipe(v.string(), v.nonEmpty(), v.maxLength(128)),
    session_file: v.optional(v.nullable(LocalPathSchema)),
  }),
  v.transform((row) => ({
    taskId: row.task_id,
    sessionId: row.session_id,
    ownerId: row.owner_id,
    ...(row.session_file ? { sessionFile: row.session_file } : {}),
  })),
);
export type TaskAttachment = v.InferOutput<typeof TaskAttachmentRowSchema>;

function privateFile(path: string, create: boolean): void {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDWR | constants.O_NOFOLLOW | (create ? constants.O_CREAT : 0), 0o600);
  } catch (error) {
    if (!create && error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || (process.getuid && stat.uid !== process.getuid())) {
      throw new Error("Database files must be regular files owned by this user, without links.");
    }
    fchmodSync(fd, 0o600);
  } finally {
    closeSync(fd);
  }
}

export class Store {
  readonly db: Database;

  constructor(input: string) {
    const path = input === ":memory:" ? input : preparePrivatePath(input);
    if (path !== ":memory:") {
      privateFile(path, true);
      for (const suffix of ["-wal", "-shm", "-journal"]) privateFile(path + suffix, false);
    }
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec(`
			PRAGMA journal_mode=WAL;
			PRAGMA synchronous=FULL;
			PRAGMA foreign_keys=ON;
			PRAGMA busy_timeout=5000;
			CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, directory TEXT NOT NULL UNIQUE);
			CREATE TABLE IF NOT EXISTS bindings (container TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id));
			CREATE TABLE IF NOT EXISTS tasks (
				id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), container TEXT NOT NULL,
				root_id TEXT NOT NULL, title TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(container, root_id)
			);
			CREATE TABLE IF NOT EXISTS task_attachments (
				task_id TEXT PRIMARY KEY REFERENCES tasks(id), session_id TEXT NOT NULL UNIQUE, owner_id TEXT NOT NULL,
        session_file TEXT
			);
			CREATE TABLE IF NOT EXISTS message_routes (
				container TEXT NOT NULL, message_id TEXT NOT NULL, task_id TEXT NOT NULL REFERENCES tasks(id),
				PRIMARY KEY(container, message_id)
			);
			CREATE TABLE IF NOT EXISTS inputs (
				sequence INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL REFERENCES tasks(id),
				container TEXT NOT NULL, message_id TEXT NOT NULL, author_id TEXT NOT NULL, text TEXT NOT NULL,
				created_at TEXT NOT NULL, UNIQUE(container, message_id)
			);
			CREATE TABLE IF NOT EXISTS transport_cursors (
				transport_id TEXT PRIMARY KEY, next_offset INTEGER NOT NULL, updated_at INTEGER NOT NULL
			);
			DROP TABLE IF EXISTS processed_updates;
			CREATE TABLE IF NOT EXISTS outbox (
				id INTEGER PRIMARY KEY AUTOINCREMENT, transport_id TEXT NOT NULL, container TEXT NOT NULL,
				reply_to_id TEXT NOT NULL, task_id TEXT REFERENCES tasks(id), text TEXT NOT NULL,
				attempts INTEGER NOT NULL DEFAULT 0, available_at INTEGER NOT NULL DEFAULT 0,
				error TEXT, state TEXT NOT NULL DEFAULT 'pending'
			);
		`);
    const columns = v.parse(
      v.array(v.object({ name: v.string() })),
      this.db.query("PRAGMA table_info(task_attachments)").all(),
    );
    if (!columns.some((column) => column.name === "session_file"))
      this.db.exec("ALTER TABLE task_attachments ADD COLUMN session_file TEXT");
    if (path !== ":memory:") for (const suffix of ["-wal", "-shm"]) privateFile(path + suffix, false);
  }

  close(): void {
    this.db.close();
  }
  atomic<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  private one<S extends v.GenericSchema>({
    schema,
    sql,
    params = [],
  }: {
    schema: S;
    sql: string;
    params?: SQLQueryBindings[];
  }): v.InferOutput<S> | null {
    const row = this.db.query(sql).get(...params);
    return row === null ? null : v.parse(schema, row);
  }
  private many<S extends v.GenericSchema>({
    schema,
    sql,
    params = [],
  }: {
    schema: S;
    sql: string;
    params?: SQLQueryBindings[];
  }): v.InferOutput<S>[] {
    return v.parse(v.array(schema), this.db.query(sql).all(...params));
  }

  project(id: ProjectId): Project | null {
    return this.one({
      schema: ProjectSchema,
      sql: "SELECT * FROM projects WHERE id=?",
      params: [id],
    });
  }
  saveProject(project: Project): void {
    this.db.query("INSERT INTO projects VALUES (?, ?, ?)").run(project.id, project.name, project.directory);
  }
  registerProject(directory: string): Project {
    const existing = this.one({
      schema: ProjectSchema,
      sql: "SELECT * FROM projects WHERE directory=?",
      params: [directory],
    });
    if (existing) return existing;
    const project: Project = {
      id: v.parse(ProjectIdSchema, `project_${randomUUID()}`),
      name: basename(directory) || directory,
      directory,
    };
    this.saveProject(project);
    return project;
  }
  binding(container: Container): ProjectId | null {
    return (
      this.one({
        schema: v.object({ project_id: ProjectIdSchema }),
        sql: "SELECT project_id FROM bindings WHERE container=?",
        params: [containerKey(container)],
      })?.project_id ?? null
    );
  }
  bind({ container, projectId }: { container: Container; projectId: ProjectId }): void {
    const current = this.binding(container);
    if (current && current !== projectId) throw new Error("Already bound to another directory. Use /unbind first.");
    this.db.query("INSERT OR IGNORE INTO bindings VALUES (?, ?)").run(containerKey(container), projectId);
  }
  unbind(container: Container): void {
    this.db.query("DELETE FROM bindings WHERE container=?").run(containerKey(container));
  }
  task(id: TaskId): Task | null {
    return this.one({ schema: TaskRowSchema, sql: "SELECT * FROM tasks WHERE id=?", params: [id] });
  }
  tasksFor(container: Container): Task[] {
    return this.many({
      schema: TaskRowSchema,
      sql: "SELECT * FROM tasks WHERE container=? ORDER BY created_at DESC, rowid DESC",
      params: [containerKey(container)],
    });
  }
  taskAttachment(taskId: TaskId): TaskAttachment | null {
    return this.one({
      schema: TaskAttachmentRowSchema,
      sql: "SELECT * FROM task_attachments WHERE task_id=?",
      params: [taskId],
    });
  }
  attachmentForSession(sessionId: string): TaskAttachment | null {
    return this.one({
      schema: TaskAttachmentRowSchema,
      sql: "SELECT * FROM task_attachments WHERE session_id=?",
      params: [sessionId],
    });
  }
  attachTask(attachment: TaskAttachment): void {
    const row = v.parse(TaskAttachmentRowSchema, {
      task_id: attachment.taskId,
      session_id: attachment.sessionId,
      owner_id: attachment.ownerId,
      session_file: attachment.sessionFile,
    });
    this.atomic(() => {
      if (!this.task(row.taskId)) throw new Error("Unknown thread.");
      const existing = this.taskAttachment(row.taskId);
      if (existing) {
        if (existing.sessionId === row.sessionId && existing.ownerId === row.ownerId) {
          if (row.sessionFile) {
            if (existing.sessionFile && existing.sessionFile !== row.sessionFile)
              throw new Error("This thread already has a different saved session file.");
            this.db
              .query("UPDATE task_attachments SET session_file=? WHERE task_id=?")
              .run(row.sessionFile, row.taskId);
          }
          return;
        }
        throw new Error(
          "This thread belongs to another session. Explicitly release its attachment before replacing it.",
        );
      }
      if (this.attachmentForSession(row.sessionId))
        throw new Error("This session is already assigned to another thread.");
      this.db
        .query("INSERT INTO task_attachments (task_id,session_id,owner_id,session_file) VALUES (?, ?, ?, ?)")
        .run(row.taskId, row.sessionId, row.ownerId, row.sessionFile ?? null);
    });
  }
  /** Only an authorized, explicit replacement may forget a durable session association. */
  detachTask(taskId: TaskId): void {
    this.db.query("DELETE FROM task_attachments WHERE task_id=?").run(taskId);
  }
  taskForMessage({ container, messageId }: { container: Container; messageId: MessageId }): Task | null {
    return this.one({
      schema: TaskRowSchema,
      sql: `SELECT tasks.* FROM tasks JOIN message_routes ON tasks.id=message_routes.task_id
			WHERE message_routes.container=? AND message_routes.message_id=?`,
      params: [containerKey(container), messageId],
    });
  }
  taskForRoot({ container, rootId }: { container: Container; rootId: MessageId }): Task | null {
    return this.one({
      schema: TaskRowSchema,
      sql: "SELECT * FROM tasks WHERE container=? AND root_id=?",
      params: [containerKey(container), rootId],
    });
  }
  createTask(task: Task): void {
    this.db
      .query("INSERT INTO tasks VALUES (?, ?, ?, ?, ?, ?)")
      .run(task.id, task.projectId, containerKey(task.container), task.rootId, task.title, task.createdAt);
  }
  mapMessage({ container, messageId, taskId }: { container: Container; messageId: MessageId; taskId: TaskId }): void {
    const existing = this.taskForMessage({ container, messageId });
    if (existing && existing.id !== taskId) throw new Error("Message already belongs to another task");
    this.db
      .query("INSERT OR IGNORE INTO message_routes VALUES (?, ?, ?)")
      .run(containerKey(container), messageId, taskId);
  }
  taskAuthor(taskId: TaskId): UserId | undefined {
    return this.one({
      schema: v.object({ author_id: UserIdSchema }),
      sql: "SELECT author_id FROM inputs WHERE task_id=? ORDER BY sequence LIMIT 1",
      params: [taskId],
    })?.author_id;
  }
  recordInput({
    task,
    messageId,
    authorId,
    text,
  }: {
    task: Task;
    messageId: MessageId;
    authorId: UserId;
    text: string;
  }): TaskInput {
    const input = this.one({
      schema: InputRowSchema,
      sql: `INSERT INTO inputs (task_id, container, message_id, author_id, text, created_at)
			VALUES (?, ?, ?, ?, ?, ?) RETURNING *`,
      params: [task.id, containerKey(task.container), messageId, authorId, text, new Date().toISOString()],
    });
    if (!input) throw new Error("SQLite did not return the inserted input");
    return input;
  }
  offset(transportId: string, now = Date.now()): number | undefined {
    const row = this.one({
      schema: v.object({ next_offset: integer, updated_at: integer }),
      sql: "SELECT next_offset, updated_at FROM transport_cursors WHERE transport_id=?",
      params: [transportId],
    });
    if (!row) return undefined;
    if (now - row.updated_at < 6 * 24 * 60 * 60 * 1000) return row.next_offset;
    this.db.query("DELETE FROM transport_cursors WHERE transport_id=?").run(transportId);
    return undefined;
  }
  /** The sole poller commits updates in order, so one watermark covers replay. */
  processed({ transportId, updateId }: { transportId: string; updateId: number }, now = Date.now()): boolean {
    const nextOffset = this.offset(transportId, now);
    return nextOffset !== undefined && updateId < nextOffset;
  }
  advance({
    transportId,
    nextOffset,
    now = Date.now(),
  }: {
    transportId: string;
    nextOffset: number;
    now?: number;
  }): void {
    this.atomic(() => {
      const committed = this.offset(transportId, now);
      this.db
        .query(`INSERT INTO transport_cursors VALUES (?, ?, ?) ON CONFLICT(transport_id)
				DO UPDATE SET next_offset=excluded.next_offset, updated_at=excluded.updated_at`)
        .run(transportId, Math.max(committed ?? nextOffset, nextOffset), now);
    });
  }
  recoverBotReply({
    transportId,
    container,
    messageId,
    text,
  }: {
    transportId: string;
    container: Container;
    messageId: MessageId;
    text: string;
  }): void {
    if (this.taskForMessage({ container, messageId })) return;
    const task = this.one({
      schema: TaskRowSchema,
      // Text can recover an uncertain send only when it identifies one conversation.
      sql: `SELECT tasks.* FROM tasks JOIN (
        SELECT min(task_id) AS task_id FROM outbox
        WHERE transport_id=? AND container=? AND text=?
        HAVING count(DISTINCT task_id)=1
      ) AS candidate ON tasks.id=candidate.task_id WHERE tasks.container=?`,
      params: [transportId, containerKey(container), text, containerKey(container)],
    });
    if (task) this.mapMessage({ container, messageId, taskId: task.id });
  }
  enqueue(reply: Omit<PendingReply, "id" | "attempts" | "availableAt">): void {
    this.db
      .query("INSERT INTO outbox (transport_id, container, reply_to_id, task_id, text) VALUES (?, ?, ?, ?, ?)")
      .run(reply.transportId, containerKey(reply.container), reply.replyToId, reply.taskId, reply.text);
  }
  nextReply(transportId: string, now = Date.now()): PendingReply | null {
    return this.one({
      schema: ReplyRowSchema,
      sql: `SELECT * FROM outbox WHERE transport_id=? AND state='pending'
			AND available_at<=? ORDER BY id LIMIT 1`,
      params: [transportId, now],
    });
  }
  sent({ reply, messageId }: { reply: PendingReply; messageId: MessageId }): void {
    this.atomic(() => {
      if (reply.taskId)
        this.mapMessage({
          container: reply.container,
          messageId,
          taskId: reply.taskId,
        });
      this.db.query("UPDATE outbox SET state='sent', error=NULL WHERE id=?").run(reply.id);
    });
  }
  failed({ reply, error, retryAt }: { reply: PendingReply; error: string; retryAt: number | null }): void {
    this.db
      .query("UPDATE outbox SET attempts=attempts+1, error=?, available_at=?, state=? WHERE id=?")
      .run(error, retryAt ?? 0, retryAt === null ? "failed" : "pending", reply.id);
  }
  statistics(transportId: string) {
    const result = this.one({
      schema: StatisticsSchema,
      sql: `SELECT
			(SELECT count(*) FROM bindings) AS topics,
			(SELECT count(*) FROM tasks) AS tasks,
			(SELECT count(*) FROM outbox WHERE transport_id=? AND state='pending') AS pendingReplies,
			(SELECT count(*) FROM outbox WHERE transport_id=? AND state='failed') AS failedReplies`,
      params: [transportId, transportId],
    });
    if (!result) throw new Error("Database statistics are unavailable.");
    return result;
  }
  snapshot() {
    return {
      projects: this.many({
        schema: ProjectSchema,
        sql: "SELECT * FROM projects ORDER BY directory",
      }),
      bindings: this.many({
        schema: v.pipe(
          v.object({ container: v.string(), project_id: ProjectIdSchema }),
          v.transform(
            (row) =>
              ({
                ...parseContainerKey(row.container),
                projectId: row.project_id,
              }) satisfies Binding,
          ),
        ),
        sql: "SELECT * FROM bindings ORDER BY container",
      }),
      tasks: this.many({
        schema: TaskRowSchema,
        sql: "SELECT * FROM tasks ORDER BY created_at, id",
      }),
      attachments: this.many({
        schema: TaskAttachmentRowSchema,
        sql: "SELECT * FROM task_attachments ORDER BY task_id",
      }),
      inputs: this.many({
        schema: InputRowSchema,
        sql: "SELECT * FROM inputs ORDER BY sequence",
      }),
      outbox: this.many({
        schema: v.object({
          id: integer,
          state: v.picklist(["pending", "sent", "failed"]),
          attempts: integer,
          error: v.nullable(v.string()),
        }),
        sql: "SELECT id, state, attempts, error FROM outbox ORDER BY id",
      }),
    };
  }
}
