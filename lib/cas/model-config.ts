import "server-only"

import { getDb, must } from "@/lib/db"

import { modelConfig, modelForTask, type ModelTask } from "./models"

/** The household's model config: settings rows (casModel.*) over the environment over defaults. */
export async function loadModelConfig() {
  const rows = await must<{ key: string; value: string }[]>(
    (await getDb()).from("settings").select("key, value").like("key", "casModel.%")
  ).catch(() => [])
  return modelConfig(new Map(rows.map((r) => [r.key, r.value])), process.env)
}

export async function modelFor(task: ModelTask) {
  return modelForTask(await loadModelConfig(), task)
}
