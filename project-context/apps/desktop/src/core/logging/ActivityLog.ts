export type LogEntry = {
  id: string;
  timestamp: string;
  message: string;
};

export class ActivityLog {
  private entries: LogEntry[] = [];

  add(message: string) {
    this.entries.push({
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      message
    });
  }

  list(): LogEntry[] {
    return [...this.entries];
  }
}
