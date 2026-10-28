import "server-only"

import Papa from "papaparse"

import { getDb, getOwnerId } from "@/lib/db"

/**
 * Private storage bucket for the original statement files (see supabase/migrations),
 * each under its owner's folder: <user id>/<stored name>.
 */
const BUCKET = "statements"
const STORED_NAME = /^\d+-[A-Za-z0-9._-]+$/

export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024
export const ALLOWED_EXTENSIONS = [".csv", ".tsv", ".txt"]

function checkStored(storedName: string) {
  if (!STORED_NAME.test(storedName)) throw new Error("Invalid file reference")
  return storedName
}

/** The bucket, and a function giving a stored file's path in the user's folder. */
async function userFiles() {
  const db = await getDb()
  const folder = await getOwnerId(db)
  return {
    files: db.storage.from(BUCKET),
    folder,
    path: (storedName: string) => `${folder}/${checkStored(storedName)}`,
  }
}

export async function saveUpload(file: File) {
  const safe = file.name.replace(/[^A-Za-z0-9._-]+/g, "_").slice(-100) || "statement.csv"
  const storedName = `${Date.now()}-${safe}`
  const { files, path } = await userFiles()
  const { error } = await files.upload(path(storedName), file, {
    contentType: "text/plain",
  })
  if (error) throw error
  return storedName
}

export async function readStoredRows(storedName: string): Promise<string[][]> {
  const { files, path } = await userFiles()
  const { data, error } = await files.download(path(storedName))
  if (error) throw error
  const text = (await data.text()).replace(/^﻿/, "")
  const result = Papa.parse<string[]>(text, { skipEmptyLines: "greedy" })
  return result.data.map((row) => row.map((c) => (c ?? "").toString()))
}

export async function deleteStored(...storedNames: string[]) {
  if (storedNames.length === 0) return
  const { files, path } = await userFiles()
  await files.remove(storedNames.map(path))
}

/** Remove uploads older than a day that never became an import (abandoned previews). */
export async function pruneOrphanUploads(referenced: Set<string>) {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000
  const { files, folder } = await userFiles()
  const { data, error } = await files.list(folder, { limit: 1000 })
  if (error) throw error
  const orphans = data
    .filter((f) => STORED_NAME.test(f.name) && !referenced.has(f.name))
    .filter((f) => f.created_at && Date.parse(f.created_at) < cutoff)
    .map((f) => f.name)
  await deleteStored(...orphans)
}
