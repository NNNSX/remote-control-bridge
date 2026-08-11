export async function authorizeTusRequest(request, uploadId, { getSession, transferStore }) {
  const sessionId = request.headers.get("x-rcb-session");
  if (!sessionId) throw { status_code: 401, body: "SSH session header required" };
  let session;
  try { session = getSession(sessionId); }
  catch { throw { status_code: 401, body: "SSH session is unavailable" }; }

  // On POST, tus supplies the newly generated ID before the store record exists.
  if (uploadId && String(request.method || "").toUpperCase() !== "POST") await transferStore.rebind(uploadId, session);
  return session;
}

