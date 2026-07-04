import { TableInfo } from "../db";

export function formatSchema(tables: TableInfo[]): string {
  return tables
    .map((t) => {
      const cols = t.columns.map((c) => `${c.name} ${c.dataType}${c.isNullable ? "" : " NOT NULL"}`).join(", ");
      return `${t.schema}.${t.name}(${cols})`;
    })
    .join("\n");
}
