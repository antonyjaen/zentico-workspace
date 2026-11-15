// Minimal typings for Node's built-in SQLite (node:sqlite, stable enough on Node 24). The project
// pins @types/node 20, which predates the module. Drop this file if @types/node is upgraded to 22+.
declare module "node:sqlite" {
  export type SQLValue = null | number | bigint | string | Uint8Array;
  export type SQLParam = SQLValue | Record<string, SQLValue>;
  export type Row = Record<string, SQLValue>;

  export class StatementSync {
    run(...params: SQLParam[]): { changes: number | bigint; lastInsertRowid: number | bigint };
    get(...params: SQLParam[]): Row | undefined;
    all(...params: SQLParam[]): Row[];
  }

  export class DatabaseSync {
    constructor(
      path: string,
      options?: { open?: boolean; readOnly?: boolean; enableForeignKeyConstraints?: boolean; timeout?: number },
    );
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
}
