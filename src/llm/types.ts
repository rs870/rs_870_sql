export interface GeneratedSql {
  sql: string;
  explanation: string;
}

export interface PreviousAttempt {
  sql: string;
  error: string;
}
