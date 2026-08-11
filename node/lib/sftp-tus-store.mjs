import fs from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { DataStore, Upload, ERRORS } from "@tus/utils";

function conflict(message) {
  const error = new Error(message);
  error.status_code = 409;
  error.body = `${message}\n`;
  return error;
}

function allowsOverwrite(record) {
  return record.overwrite === true || record.metadata?.overwrite === "true";
}

// Tus metadata lives on the host; payload bytes stay on the remote SFTP server.
export class SftpTusStore extends DataStore {
  constructor({ metadataDir, getSession, safeRelative, openSftp, closeSftp }) {
    super();
    this.metadataDir = metadataDir;
    this.getSession = getSession;
    this.safeRelative = safeRelative;
    this.openSftp = openSftp;
    this.closeSftp = closeSftp;
    this.extensions = ["creation", "creation-with-upload", "termination"];
    this.ready = fs.mkdir(metadataDir, { recursive: true });
  }

  recordPath(id) {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) throw ERRORS.FILE_NOT_FOUND;
    return path.join(this.metadataDir, `${id}.json`);
  }

  async readRecord(id) {
    await this.ready;
    try { return JSON.parse(await fs.readFile(this.recordPath(id), "utf8")); }
    catch (error) { if (error.code === "ENOENT") throw ERRORS.FILE_NOT_FOUND; throw error; }
  }

  async writeRecord(record) {
    await this.ready;
    const target = this.recordPath(record.id);
    const temp = `${target}.tmp`;
    await fs.writeFile(temp, JSON.stringify(record), { encoding: "utf8", mode: 0o600 });
    await fs.rename(temp, target);
  }

  async deleteRecord(id) { await fs.rm(this.recordPath(id), { force: true }); }

  async sftpCall(session, method, ...args) {
    const sftp = await this.openSftp(session);
    try {
      const result = await new Promise((resolve, reject) => sftp[method](...args, (error, value) => error ? reject(error) : resolve(value)));
      return { sftp, result };
    } catch (error) { this.closeSftp(sftp); throw error; }
  }

  async exists(sftp, remotePath) {
    try { await new Promise((resolve, reject) => sftp.lstat(remotePath, (error, value) => error ? reject(error) : resolve(value))); return true; }
    catch (error) { if (error?.code === 2 || error?.code === "ENOENT") return false; throw error; }
  }

  async mkdirp(sftp, remotePath) {
    const directory = path.posix.dirname(remotePath);
    if (!directory || directory === ".") return;
    let current = "";
    for (const part of directory.split("/")) {
      if (!part || part === ".") continue;
      current = current ? `${current}/${part}` : part;
      if (!(await this.exists(sftp, current))) await new Promise((resolve, reject) => sftp.mkdir(current, (error) => error && error.code !== 4 ? reject(error) : resolve()));
    }
  }

  async moveIntoPlace(sftp, record) {
    const targetExists = await this.exists(sftp, record.target);
    if (!targetExists) {
      await new Promise((resolve, reject) => sftp.rename(record.part, record.target, (error) => error ? reject(error) : resolve()));
      return;
    }
    if (!allowsOverwrite(record)) throw conflict("target file already exists");
    try {
      await new Promise((resolve, reject) => sftp.ext_openssh_rename(record.part, record.target, (error) => error ? reject(error) : resolve()));
    } catch (error) {
      throw conflict(`atomic overwrite is unavailable: ${error.message || "remote SFTP server does not support it"}`);
    }
  }

  async create(file) {
    const metadata = file.metadata || {};
    const sessionId = metadata.session;
    const target = this.safeRelative(metadata.path || "");
    if (!sessionId || !target || target === ".") throw new Error("upload metadata must include a target path and session");
    const session = this.getSession(sessionId);
    const sftp = await this.openSftp(session);
    const part = `${target}.rcb-upload-${file.id}.part`;
    const overwrite = metadata.overwrite === "true";
    try {
      if (await this.exists(sftp, target) && !overwrite) throw conflict("target file already exists");
      await this.mkdirp(sftp, target);
      const handle = await new Promise((resolve, reject) => sftp.open(part, "wx", 0o644, (error, value) => error ? reject(error) : resolve(value)));
      await new Promise((resolve) => sftp.close(handle, () => resolve()));
    } finally { this.closeSftp(sftp); }
    const record = { id: file.id, size: file.size, offset: 0, metadata, overwrite, session_id: sessionId, host: session.host, port: session.port, username: session.username, target, part, creation_date: file.creation_date || new Date().toISOString(), completed: false };
    file.storage = { type: "sftp", path: part };
    await this.writeRecord(record);
    return file;
  }

  async getUpload(id) {
    const record = await this.readRecord(id);
    const session = this.getSession(record.session_id);
    const sftp = await this.openSftp(session);
    try {
      const activePath = record.completed ? record.target : record.part;
      const stat = await new Promise((resolve, reject) => sftp.stat(activePath, (error, value) => error ? reject(error) : resolve(value)));
      const offset = Number(stat.size || 0);
      if (!record.completed && Number.isFinite(record.size) && offset === record.size) {
        await this.moveIntoPlace(sftp, record);
        record.completed = true; record.offset = offset; await this.writeRecord(record);
      }
      record.offset = offset;
      return new Upload({ id, size: record.size, offset, metadata: record.metadata, creation_date: record.creation_date, storage: { type: "sftp", path: activePath } });
    } finally { this.closeSftp(sftp); }
  }

  async write(readable, id, offset) {
    const record = await this.readRecord(id);
    const session = this.getSession(record.session_id);
    const sftp = await this.openSftp(session);
    let received = 0;
    const counter = new Transform({ transform(chunk, encoding, callback) { received += chunk.length; callback(null, chunk); } });
    try {
      const stat = await new Promise((resolve, reject) => sftp.stat(record.part, (error, value) => error ? reject(error) : resolve(value)));
      if (Number(stat.size || 0) !== offset) throw new Error("upload offset does not match remote part");
      await pipeline(readable, counter, sftp.createWriteStream(record.part, { flags: "r+", start: offset }));
      const next = offset + received;
      record.offset = next; await this.writeRecord(record);
      if (Number.isFinite(record.size) && next === record.size) {
        await this.moveIntoPlace(sftp, record);
        record.completed = true; await this.writeRecord(record);
      }
      return next;
    } finally { this.closeSftp(sftp); }
  }

  async remove(id) {
    const record = await this.readRecord(id);
    try {
      const session = this.getSession(record.session_id);
      const sftp = await this.openSftp(session);
      try { await new Promise((resolve) => sftp.unlink(record.completed ? record.target : record.part, () => resolve())); }
      finally { this.closeSftp(sftp); }
    } finally { await this.deleteRecord(id); }
  }

  async declareUploadLength(id, length) { const record = await this.readRecord(id); record.size = length; await this.writeRecord(record); }
  async deleteExpired() { return 0; }
  getExpiration() { return 0; }

  async listForSession(session) {
    await this.ready;
    const result = [];
    for (const file of await fs.readdir(this.metadataDir)) {
      if (!file.endsWith(".json")) continue;
      try {
        const record = JSON.parse(await fs.readFile(path.join(this.metadataDir, file), "utf8"));
        if (record.host !== session.host || Number(record.port) !== Number(session.port) || record.username !== session.username) continue;
        if (!record.completed) { record.session_id = session.id; await this.writeRecord(record); }
        result.push({ id: record.id, path: record.target, size: record.size, offset: record.offset || 0, completed: Boolean(record.completed), creation_date: record.creation_date, metadata: record.metadata });
      } catch {}
    }
    return result.sort((a, b) => String(b.creation_date).localeCompare(String(a.creation_date)));
  }

  async rebind(id, session) {
    const record = await this.readRecord(id);
    if (record.host !== session.host || Number(record.port) !== Number(session.port) || record.username !== session.username) throw new Error("transfer belongs to another SSH identity");
    if (!record.completed) { record.session_id = session.id; await this.writeRecord(record); }
    return record;
  }

  async discardForSession(id, session) {
    const record = await this.rebind(id, session);
    if (record.completed) {
      await this.deleteRecord(id);
      return { id, completed: true, file_preserved: true };
    }
    await this.remove(id);
    return { id, completed: false, file_preserved: false };
  }
}
