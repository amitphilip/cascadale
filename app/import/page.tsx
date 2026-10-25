import type { Metadata } from "next"

import { AkahuPanel } from "./akahu-panel"
import { ImportWizard } from "./import-wizard"
import { DeleteStatementButton } from "./statement-actions"
import { PageHeader } from "@/components/page-header"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { getAkahuOverview } from "@/lib/akahu"
import { formatDate } from "@/lib/format"
import { getAccountsWithBalances, getSettings, getStatements } from "@/lib/queries"

export const metadata: Metadata = { title: "Import statements" }

export default async function ImportPage({
  searchParams,
}: {
  searchParams: Promise<{ account?: string }>
}) {
  const { account } = await searchParams
  const [accounts, statements, fmt, akahu] = await Promise.all([
    getAccountsWithBalances(),
    getStatements(),
    getSettings(),
    getAkahuOverview(),
  ])
  const active = accounts.filter((a) => !a.archived).map((a) => ({ id: a.id, name: a.name }))

  return (
    <>
      <PageHeader
        title="Import statements"
        description="Files are kept in ./data/uploads so you always have the originals."
      />
      <AkahuPanel overview={akahu} accounts={active} fmt={fmt} />
      <ImportWizard
        accounts={active}
        initialAccountId={Number(account) || undefined}
        fmt={fmt}
      />
      {statements.length > 0 && (
        <Card className="pb-0">
          <CardHeader>
            <CardTitle>Import history</CardTitle>
          </CardHeader>
          <CardContent className="px-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-4">File</TableHead>
                  <TableHead>Account</TableHead>
                  <TableHead>Period</TableHead>
                  <TableHead className="text-right">New / rows</TableHead>
                  <TableHead>Imported</TableHead>
                  <TableHead className="pr-4" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {statements.map((s) => (
                  <TableRow key={s.id}>
                    <TableCell className="max-w-64 truncate pl-4 font-medium">
                      {s.fileName}
                    </TableCell>
                    <TableCell>{s.accountName}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {s.periodStart && s.periodEnd
                        ? `${formatDate(s.periodStart, fmt.locale)} – ${formatDate(s.periodEnd, fmt.locale)}`
                        : "—"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {s.insertedCount} / {s.rowCount}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {new Date(s.importedAt).toLocaleDateString(fmt.locale)}
                    </TableCell>
                    <TableCell className="pr-4 text-right">
                      <DeleteStatementButton id={s.id} fileName={s.fileName} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </>
  )
}
