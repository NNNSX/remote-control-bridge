import crypto from "node:crypto";
import path from "node:path";

const MAX_EXEC_OUTPUT_BYTES = 1024 * 1024;

function call(target, method, ...args) {
  return new Promise((resolve, reject) => target[method](...args, (error, result) => error ? reject(error) : resolve(result)));
}

async function closeHandle(sftp, handle) { try { await call(sftp, "close", handle); } catch {} }

async function ensureDirectory(sftp, relative) {
  let current = "";
  for (const part of relative.split("/").filter(Boolean)) {
    current = current ? `${current}/${part}` : part;
    try {
      const stat = await call(sftp, "stat", current);
      if (!stat.isDirectory()) throw new Error(`${current} is not a directory`);
    } catch (error) {
      try { await call(sftp, "mkdir", current, { mode: 0o700 }); }
      catch (mkdirError) {
        try { const stat = await call(sftp, "stat", current); if (stat.isDirectory()) continue; } catch {}
        throw mkdirError;
      }
    }
  }
}

async function readBytes(sftp, target, maxBytes) {
  const handle = await call(sftp, "open", target, "r");
  try {
    const stat = await call(sftp, "fstat", handle);
    if (stat.isDirectory()) throw new Error("task record cannot be a directory");
    const size = Number(stat.size || 0);
    if (!Number.isSafeInteger(size) || size < 0 || size > maxBytes) throw new Error(`task record exceeds ${maxBytes} bytes`);
    const buffer = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const bytesRead = await new Promise((resolve, reject) => sftp.read(handle, buffer, offset, size - offset, offset, (error, count) => error ? reject(error) : resolve(count)));
      if (!bytesRead) break;
      offset += bytesRead;
    }
    return buffer.subarray(0, offset);
  } finally { await closeHandle(sftp, handle); }
}

async function atomicRename(sftp, from, to) {
  if (typeof sftp.ext_openssh_rename === "function") {
    try { await call(sftp, "ext_openssh_rename", from, to); return; }
    catch (error) { if (![4, "OP_UNSUPPORTED"].includes(error.code)) throw error; }
  }
  await call(sftp, "rename", from, to);
}

export function createSftpTaskRemote({ session, openSftp, closeSftp, execTimeoutMs = 30000 }) {
  async function withSftp(operation) {
    const sftp = await openSftp(session);
    try { return await operation(sftp); }
    finally { closeSftp(sftp); }
  }

  return {
    async exec(command) {
      return new Promise((resolve, reject) => session.client.exec(command, (error, stream) => {
        if (error) return reject(error);
        let stdout = "";
        let stderr = "";
        let truncated = false;
        let settled = false;
        const append = (current, chunk) => {
          const remaining = MAX_EXEC_OUTPUT_BYTES - Buffer.byteLength(current);
          if (remaining <= 0) { truncated = true; return current; }
          const accepted = Buffer.from(chunk).subarray(0, remaining).toString("utf8");
          if (accepted.length < chunk.length) truncated = true;
          return current + accepted;
        };
        const finishError = (cause) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(cause);
        };
        const finishClose = (code, signal) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({ code: Number.isInteger(code) ? code : 1, signal: signal || null, stdout, stderr, truncated });
        };
        stream.on("data", (chunk) => { stdout = append(stdout, chunk); });
        stream.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });
        const timer = setTimeout(() => {
          if (settled) return;
          try { stream.close(); } catch {}
          finishError(new Error("persistent task command timed out"));
        }, execTimeoutMs);
        stream.on("error", finishError);
        stream.on("close", finishClose);
      }));
    },
    async mkdir(relative) { return withSftp((sftp) => ensureDirectory(sftp, relative)); },
    async writeText(target, content) {
      const buffer = Buffer.from(content, "utf8");
      const temporary = `${target}.tmp-${crypto.randomBytes(8).toString("hex")}`;
      return withSftp(async (sftp) => {
        const handle = await call(sftp, "open", temporary, "w", { mode: 0o600 });
        try {
          let offset = 0;
          while (offset < buffer.length) {
            const length = Math.min(256 * 1024, buffer.length - offset);
            await new Promise((resolve, reject) => sftp.write(handle, buffer, offset, length, offset, (error) => error ? reject(error) : resolve()));
            offset += length;
          }
          try { await call(sftp, "fchmod", handle, 0o600); } catch {}
        } finally { await closeHandle(sftp, handle); }
        try { await atomicRename(sftp, temporary, target); }
        catch (error) { try { await call(sftp, "unlink", temporary); } catch {} throw error; }
      });
    },
    async readText(target, maxBytes) { return (await withSftp((sftp) => readBytes(sftp, target, maxBytes))).toString("utf8"); },
    async readRange(target, offset, length) {
      return withSftp(async (sftp) => {
        const handle = await call(sftp, "open", target, "r");
        try {
          const buffer = Buffer.alloc(length);
          let cursor = 0;
          while (cursor < length) {
            const bytesRead = await new Promise((resolve, reject) => sftp.read(handle, buffer, cursor, length - cursor, offset + cursor, (error, count) => error ? reject(error) : resolve(count)));
            if (!bytesRead) break;
            cursor += bytesRead;
          }
          return buffer.subarray(0, cursor);
        } finally { await closeHandle(sftp, handle); }
      });
    },
    async exists(target) {
      return withSftp(async (sftp) => { try { await call(sftp, "stat", target); return true; } catch { return false; } });
    },
    async list(target) {
      return withSftp(async (sftp) => (await call(sftp, "readdir", target)).map((entry) => ({ name: entry.filename, type: entry.attrs.isDirectory() ? "directory" : entry.attrs.isFile() ? "file" : "other", size: Number(entry.attrs.size || 0), modified_at: Number(entry.attrs.mtime || 0) * 1000 })));
    },
    async remove(target) { return withSftp(async (sftp) => { try { await call(sftp, "unlink", target); } catch (error) { if (![2, "ENOENT"].includes(error.code)) throw error; } }); },
    async removeDirectory(target) { return withSftp((sftp) => call(sftp, "rmdir", target)); },
  };
}

export const sftpTaskRemoteInternals = { atomicRename, ensureDirectory, readBytes };
