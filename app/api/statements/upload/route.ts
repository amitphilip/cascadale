import path from "node:path"

import {
  ALLOWED_EXTENSIONS,
  MAX_UPLOAD_BYTES,
  pruneOrphanUploads,
  readStoredRows,
  saveUpload,
} from "@/lib/import/files"
import { getDb, selectAll } from "@/lib/db"

export async function POST(request: Request) {
  const db = await getDb()
  const referenced = await selectAll<{ name: string }>((from, to) =>
    db.from("statements").select("name:stored_name").order("id").range(from, to)
  )
  await pruneOrphanUploads(new Set(referenced.map((r) => r.name)))
  const form = await request.formData()
  const file = form.get("file")
  if (!(file instanceof File)) {
    return Response.json({ error: "No file uploaded" }, { status: 400 })
  }
  if (!ALLOWED_EXTENSIONS.includes(path.extname(file.name).toLowerCase())) {
    return Response.json(
      { error: "Only CSV/TSV exports are supported right now." },
      { status: 400 }
    )
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return Response.json({ error: "File is larger than 20MB" }, { status: 400 })
  }
  const storedName = await saveUpload(file)
  const rows = await readStoredRows(storedName)
  return Response.json({ storedName, fileName: file.name, rows })
}
