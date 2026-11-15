// WOPI CheckFileInfo (GET) and lock/rename operations (POST + X-WOPI-Override).
// Called by Collabora server-to-server: auth is the sealed access_token, never cookies.
import { env } from "@/lib/env";
import {
  clearLock,
  clientFor,
  currentLock,
  decodeUtf7,
  extOf,
  FilesError,
  ID,
  isoTime,
  setLock,
  verifyWopiToken,
  WOPI_HEADERS,
  wopiError,
} from "@/lib/wopi";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ fileId: string }> };

function failure(e: unknown) {
  if (e instanceof FilesError) return wopiError(e.status === 401 ? 401 : e.status === 404 ? 404 : 500);
  return wopiError(500);
}

export async function GET(req: Request, { params }: Ctx) {
  const { fileId } = await params;
  if (!ID.test(fileId)) return wopiError(404);
  const token = await verifyWopiToken(req, fileId);
  if (!token) return wopiError(401);

  try {
    const client = clientFor(token);
    const node = await client.getNode(fileId);
    if (!node || !node.blobId) return wopiError(404);
    const ownerId = await client.accountId();
    return Response.json(
      {
        BaseFileName: node.name,
        Size: node.size ?? 0,
        OwnerId: ownerId,
        UserId: token.email || ownerId,
        UserFriendlyName: token.name || token.email,
        Version: node.blobId,
        LastModifiedTime: isoTime(node.modified),
        UserCanWrite: true,
        UserCanNotWriteRelative: true,
        UserCanRename: true,
        SupportsUpdate: true,
        SupportsLocks: true,
        SupportsGetLock: true,
        SupportsRename: true,
        PostMessageOrigin: env.appUrl,
        EnableOwnerTermination: false,
        DisablePrint: false,
        DisableExport: false,
        HideSaveOption: false,
      },
      { headers: WOPI_HEADERS },
    );
  } catch (e) {
    return failure(e);
  }
}

export async function POST(req: Request, { params }: Ctx) {
  const { fileId } = await params;
  if (!ID.test(fileId)) return wopiError(404);
  const token = await verifyWopiToken(req, fileId);
  if (!token) return wopiError(401);

  const override = req.headers.get("x-wopi-override")?.toUpperCase();
  const lock = req.headers.get("x-wopi-lock") ?? "";
  const oldLock = req.headers.get("x-wopi-oldlock");
  const current = currentLock(fileId);
  const conflict = () => wopiError(409, { "X-WOPI-Lock": current ?? "" });
  if (lock.length > 1024) return wopiError(400);

  switch (override) {
    case "LOCK": {
      if (!lock) return wopiError(400);
      if (oldLock !== null) {
        // UnlockAndRelock
        if (current !== oldLock) return conflict();
        setLock(fileId, lock);
        return wopiError(200);
      }
      if (current && current !== lock) return conflict();
      setLock(fileId, lock); // new lock, or refresh of the same lock
      return wopiError(200);
    }
    case "REFRESH_LOCK": {
      if (!lock || current !== lock) return conflict();
      setLock(fileId, lock);
      return wopiError(200);
    }
    case "UNLOCK": {
      if (!lock || current !== lock) return conflict();
      clearLock(fileId);
      return wopiError(200);
    }
    case "GET_LOCK":
      return wopiError(200, { "X-WOPI-Lock": current ?? "" });
    case "PUT_RELATIVE":
      return wopiError(501);
    case "RENAME_FILE": {
      if (current && current !== lock) return conflict();
      const raw = req.headers.get("x-wopi-requestedname");
      if (!raw) return wopiError(400);
      const requested = decodeUtf7(raw)
        .replace(/[\u0000-\u001F\u007F/\\]/g, "")
        .trim()
        .slice(0, 200);
      if (!requested) return wopiError(400, { "X-WOPI-InvalidFileNameError": "Invalid name" });
      try {
        const client = clientFor(token);
        const node = await client.getNode(fileId);
        if (!node) return wopiError(404);
        const ext = extOf(node.name);
        const name = ext && !requested.toLowerCase().endsWith(`.${ext}`) ? `${requested}.${ext}` : requested;
        await client.rename(node, name);
        return Response.json({ Name: name.slice(0, name.length - (ext ? ext.length + 1 : 0)) }, { headers: WOPI_HEADERS });
      } catch (e) {
        if (e instanceof FilesError && e.status === 400) {
          return wopiError(400, { "X-WOPI-InvalidFileNameError": "Name rejected" });
        }
        return failure(e);
      }
    }
    default:
      return wopiError(501);
  }
}
